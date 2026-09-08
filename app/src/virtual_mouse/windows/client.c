#include "wire.h"
#include <stdio.h>

struct VmClient {
    HWND hwnd;
    DWORD pid, tid, timeout_ms;
    HANDLE mapping;
    VmShared *shared;
    HMODULE library;
    HHOOK hook;
    ATOM atom;
    UINT control;
    uintptr_t token;
    int32_t width, height;
    ULONGLONG deadline;
    int intercepting, uncertain;
};
static volatile LONG sequence = 0;

/* Native messages use the receiver's client coordinate space. Query geometry
   in that same DPI context, independent of the host executable's manifest. */
static BOOL client_rect(HWND hwnd, RECT *rect) {
    DPI_AWARENESS_CONTEXT previous = SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(hwnd));
    BOOL result = GetClientRect(hwnd, rect);
    if (previous) SetThreadDpiAwarenessContext(previous);
    return result;
}
static BOOL client_to_screen(HWND hwnd, POINT *point) {
    DPI_AWARENESS_CONTEXT previous = SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(hwnd));
    BOOL result = ClientToScreen(hwnd, point);
    if (previous) SetThreadDpiAwarenessContext(previous);
    return result;
}

static uintptr_t creation_time(HANDLE process) {
    FILETIME created, exited, kernel, user;
    if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) return 0;
    return ((uintptr_t)created.dwHighDateTime << 32) | created.dwLowDateTime;
}
static int owner_dead(HWND hwnd, uintptr_t token) {
    HANDLE owner = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)(token >> 32));
    if (!owner) return GetLastError() == ERROR_INVALID_PARAMETER;
    uintptr_t created = creation_time(owner);
    uintptr_t recorded = (uintptr_t)GetPropW(hwnd, VM_OWNER_TIME_PROPERTY);
    int dead = WaitForSingleObject(owner, 0) == WAIT_OBJECT_0 || (created && recorded && created != recorded);
    CloseHandle(owner);
    return dead;
}
static HANDLE lock_target(HWND hwnd, DWORD timeout) {
    wchar_t name[96];
    swprintf(name, 96, L"Local\\BKA.VM.Bind.%llu", (unsigned long long)(uintptr_t)hwnd);
    HANDLE gate = CreateMutexW(NULL, FALSE, name);
    if (!gate) return NULL;
    DWORD wait = WaitForSingleObject(gate, timeout);
    if (wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED) return gate;
    CloseHandle(gate); return NULL;
}
static void unlock_target(HANDLE gate) { ReleaseMutex(gate); CloseHandle(gate); }

int vm_alive(VmClient *c) {
    DWORD pid = 0;
    RECT rect;
    int alive = c && IsWindow(c->hwnd) && GetWindowThreadProcessId(c->hwnd, &pid) == c->tid &&
           pid == c->pid && (uintptr_t)GetPropW(c->hwnd, VM_OWNER_PROPERTY) == c->token &&
           client_rect(c->hwnd, &rect) && rect.right > rect.left && rect.bottom > rect.top;
    if (alive) { c->width = rect.right - rect.left; c->height = rect.bottom - rect.top; }
    return alive;
}
void vm_begin(VmClient *c, uint32_t timeout_ms) { c->timeout_ms = timeout_ms; c->deadline = GetTickCount64() + timeout_ms; }
void vm_bounds(VmClient *c, int32_t *width, int32_t *height) { *width = c->width; *height = c->height; }
int vm_window_bounds(VmClient *c, int32_t *width, int32_t *height) {
    if (!vm_alive(c)) return VM_TARGET_LOST;
    DPI_AWARENESS_CONTEXT previous = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    RECT rect; BOOL ok = GetWindowRect(c->hwnd, &rect);
    if (previous) SetThreadDpiAwarenessContext(previous);
    if (!ok) return VM_TARGET_LOST;
    *width = rect.right - rect.left; *height = rect.bottom - rect.top;
    return VM_OK;
}
void vm_coordinate_space(VmClient *c, int window_coordinates) { if (c->shared) c->shared->window_coordinates = window_coordinates != 0; }
static DWORD remaining(VmClient *c) {
    ULONGLONG now = GetTickCount64();
    return c->deadline > now ? (DWORD)(c->deadline - now) : 0;
}

int vm_open(uintptr_t hwnd, uint32_t timeout_ms, VmClient **output) {
    if (!output || !hwnd || timeout_ms == 0) return VM_INVALID;
    *output = NULL;
    HWND target = (HWND)hwnd;
    DWORD pid = 0, tid = GetWindowThreadProcessId(target, &pid);
    if (!tid || !pid || !IsWindow(target)) return VM_TARGET_LOST;
    HANDLE gate = lock_target(target, timeout_ms);
    if (!gate) return VM_CONFLICT;
    uintptr_t previous = (uintptr_t)GetPropW(target, VM_OWNER_PROPERTY);
    if (previous && !owner_dead(target, previous)) { unlock_target(gate); return VM_CONFLICT; }
    if (previous) { RemovePropW(target, VM_OWNER_PROPERTY); RemovePropW(target, VM_OWNER_TIME_PROPERTY); }
    VmClient *c = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*c));
    if (!c) { unlock_target(gate); return VM_HOOK_FAILED; }
    c->hwnd = target; c->pid = pid; c->tid = tid; c->timeout_ms = timeout_ms;
    RECT rect;
    if (!client_rect(target, &rect) || rect.right <= rect.left || rect.bottom <= rect.top) {
        HeapFree(GetProcessHeap(), 0, c); unlock_target(gate); return VM_TARGET_LOST;
    }
    c->width = rect.right - rect.left; c->height = rect.bottom - rect.top;
    vm_begin(c, timeout_ms);
    c->token = ((uintptr_t)GetCurrentProcessId() << 32) | (uint32_t)InterlockedIncrement(&sequence);
    c->control = RegisterWindowMessageW(VM_CONTROL_NAME);
    uintptr_t created = creation_time(GetCurrentProcess());
    if (!c->control || !created || !SetPropW(target, VM_OWNER_TIME_PROPERTY, (HANDLE)created) ||
        !SetPropW(target, VM_OWNER_PROPERTY, (HANDLE)c->token)) {
        RemovePropW(target, VM_OWNER_TIME_PROPERTY);
        HeapFree(GetProcessHeap(), 0, c); unlock_target(gate); return VM_HOOK_FAILED;
    }
    unlock_target(gate);
    *output = c;
    return VM_OK;
}

static int send_control(VmClient *c, WPARAM argument, LPARAM operation) {
    DWORD_PTR result = 0;
    DWORD timeout = remaining(c);
    if (!timeout) return VM_TIMEOUT;
    if (!SendMessageTimeoutW(c->hwnd, c->control, argument, operation,
                            SMTO_ABORTIFHUNG | SMTO_BLOCK, timeout, &result)) {
        c->uncertain = 1;
        return GetLastError() == ERROR_TIMEOUT ? VM_TIMEOUT : VM_DELIVERY_FAILED;
    }
    return result == VM_READY ? VM_OK : VM_HOOK_FAILED;
}

static int load_hook(VmClient *c) {
    wchar_t path[32768];
    DWORD length = GetModuleFileNameW(NULL, path, 32768);
    if (!length || length >= 32768) return VM_HOOK_FAILED;
    while (length && path[length - 1] != L'\\') --length;
    const wchar_t name[] = L"virtual-mouse-hook.dll";
    if (!length || length + sizeof(name) / sizeof(wchar_t) > 32768) return VM_HOOK_FAILED;
    memcpy(path + length, name, sizeof(name));
    c->library = LoadLibraryExW(path, NULL, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!c->library) return VM_HOOK_FAILED;
    HOOKPROC proc = (HOOKPROC)GetProcAddress(c->library, "VmBootstrap");
    if (!proc) return VM_HOOK_FAILED;
    c->hook = SetWindowsHookExW(WH_CALLWNDPROC, proc, c->library, c->tid);
    return c->hook ? VM_OK : VM_HOOK_FAILED;
}

static void close_mapping(VmClient *c) {
    if (c->hook) { UnhookWindowsHookEx(c->hook); c->hook = NULL; }
    if (c->shared) { UnmapViewOfFile(c->shared); c->shared = NULL; }
    if (c->mapping) { CloseHandle(c->mapping); c->mapping = NULL; }
    if (c->atom) { GlobalDeleteAtom(c->atom); c->atom = 0; }
    if (c->library) { FreeLibrary(c->library); c->library = NULL; }
}

int vm_detach(VmClient *c) {
    if (!c->shared) return VM_OK;
    InterlockedExchange(&c->shared->enabled, 0);
    int result = vm_alive(c) ? send_control(c, c->token, VM_DETACH) : VM_OK;
    if (result == VM_OK) { c->uncertain = 0; c->intercepting = 0; close_mapping(c); }
    return result;
}

static int prepare_context(VmClient *c) {
    if (!vm_alive(c)) return VM_TARGET_LOST;
    if (c->shared && !c->uncertain) return VM_OK;
    if (c->shared || c->uncertain) return VM_CONFLICT;
    wchar_t name[128];
    swprintf(name, 128, L"Local\\BKA.VM.%lu.%llu", GetCurrentProcessId(), (unsigned long long)c->token);
    c->mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE, 0, sizeof(VmShared), name);
    if (!c->mapping || GetLastError() == ERROR_ALREADY_EXISTS) { close_mapping(c); return VM_CONFLICT; }
    c->shared = MapViewOfFile(c->mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(VmShared));
    if (!c->shared) { close_mapping(c); return VM_HOOK_FAILED; }
    *c->shared = (VmShared){ .magic = VM_MAGIC, .bytes = sizeof(VmShared),
        .owner_pid = GetCurrentProcessId(), .target_pid = c->pid, .target_tid = c->tid,
        .target_hwnd = (uintptr_t)c->hwnd, .token = c->token, .enabled = 1 };
    c->atom = GlobalAddAtomW(name);
    int result = c->atom ? load_hook(c) : VM_HOOK_FAILED;
    if (result == VM_OK) result = send_control(c, c->atom, VM_ATTACH);
    if (result == VM_OK && c->shared->ack == VM_READY) { /* Scoped input is ready; physical filtering remains explicit. */ }
    else {
        InterlockedExchange(&c->shared->enabled, 0);
        /* Do not free a possibly installed target context; explicit detach or
           owner death makes it pass through. */
        if (!c->uncertain) { (void)send_control(c, c->token, VM_DETACH); close_mapping(c); }
        return result == VM_OK ? VM_HOOK_FAILED : result;
    }
    if (c->hook) { UnhookWindowsHookEx(c->hook); c->hook = NULL; }
    return VM_OK;
}

int vm_intercept(VmClient *c, int enabled) {
    int result = prepare_context(c);
    if (result != VM_OK) return result;
    InterlockedExchange(&c->shared->filter_input, enabled != 0);
    c->intercepting = enabled != 0;
    return VM_OK;
}
int vm_context(VmClient *c, const uint8_t *keys, uintptr_t source_tag, int32_t x, int32_t y, uint32_t buttons) {
    int result = prepare_context(c);
    if (result != VM_OK) return result;
    if (!keys || (buttons & ~31u)) return VM_INVALID;
    memcpy(c->shared->keys, keys, 256);
    c->shared->source_tag = source_tag;
    c->shared->x = x; c->shared->y = y; c->shared->buttons = buttons;
    return VM_OK;
}
int vm_key_event(VmClient *c, uint32_t vk, int extended, int down) {
    return vm_key_event_exact(c, vk, extended, down, 0, 0, 0, 0);
}
int vm_layout_available(uintptr_t layout) {
    if (!layout) return 1;
    HKL layouts[256];
    int count = GetKeyboardLayoutList(256, layouts);
    for (int i = 0; i < count; ++i) if ((uintptr_t)layouts[i] == layout) return 1;
    return 0;
}
int vm_key_event_exact(VmClient *c, uint32_t vk, int extended, int down,
                       uint32_t scan, int has_scan, uintptr_t layout, int repeat) {
    if (!vm_alive(c)) return VM_TARGET_LOST;
    if (c->uncertain || !c->shared || vk == 0 || vk >= 256 || scan > 255 || ((down || !has_scan) && !vm_layout_available(layout)) || (repeat && !down)) return VM_INVALID;
    c->shared->event_kind = down ? VM_KEY_DOWN : VM_KEY_UP;
    c->shared->key_vk = vk; c->shared->key_extended = extended != 0;
    c->shared->key_scan = scan; c->shared->key_has_scan = has_scan != 0;
    c->shared->key_layout = layout; c->shared->key_repeat = repeat != 0;
    InterlockedExchange(&c->shared->ack, 0);
    int result = send_control(c, c->token, VM_EVENT);
    return result == VM_OK && c->shared->ack == VM_READY ? VM_OK : (result == VM_OK ? VM_DELIVERY_FAILED : result);
}
uint32_t vm_last_key_scan(VmClient *c) { return c && c->shared ? c->shared->key_scan & 0xff : 0; }
int vm_keyboard_message(VmClient *c, uint32_t message, uint32_t value, uint32_t bits, uintptr_t layout) {
    if (message == WM_KEYDOWN || message == WM_KEYUP || message == WM_SYSKEYDOWN || message == WM_SYSKEYUP) {
        if (!value || value > 255) return VM_INVALID;
    } else if (message == WM_CHAR || message == WM_DEADCHAR || message == WM_SYSCHAR || message == WM_SYSDEADCHAR) {
        if (value > 0xffff) return VM_INVALID;
    } else if (message != WM_UNICHAR || value > 0x10ffff) return VM_INVALID;
    if (!vm_alive(c)) return VM_TARGET_LOST;
    if (c->uncertain || !c->shared ||
        ((message == WM_KEYDOWN || message == WM_SYSKEYDOWN) && !vm_layout_available(layout))) return VM_INVALID;
    c->shared->event_kind = VM_KEYBOARD_MESSAGE;
    c->shared->keyboard_message = message; c->shared->keyboard_value = value; c->shared->keyboard_bits = bits;
    c->shared->key_scan = (bits >> 16) & 0xff; c->shared->key_has_scan = 1; c->shared->key_layout = layout;
    InterlockedExchange(&c->shared->ack, 0);
    int result = send_control(c, c->token, VM_EVENT);
    return result == VM_OK && c->shared->ack == VM_READY ? VM_OK : (result == VM_OK ? VM_DELIVERY_FAILED : result);
}

int vm_character(VmClient *c, uint16_t character) {
    if (!vm_alive(c)) return VM_TARGET_LOST;
    if (c->uncertain || !c->shared) return VM_INVALID;
    c->shared->event_kind = VM_CHAR; c->shared->character = character;
    InterlockedExchange(&c->shared->ack, 0);
    int result = send_control(c, c->token, VM_EVENT);
    return result == VM_OK && c->shared->ack == VM_READY ? VM_OK : (result == VM_OK ? VM_DELIVERY_FAILED : result);
}

static int send_event(VmClient *c, UINT message, WPARAM flags, LPARAM point) {
    DWORD_PTR result;
    DWORD timeout = remaining(c);
    if (!timeout) return VM_TIMEOUT;
    if (SendMessageTimeoutW(c->hwnd, message, flags, point, SMTO_ABORTIFHUNG | SMTO_BLOCK,
                            timeout, &result)) return VM_OK;
    c->uncertain = 1;
    return GetLastError() == ERROR_TIMEOUT ? VM_TIMEOUT : VM_DELIVERY_FAILED;
}

int vm_event(VmClient *c, uint32_t kind, int32_t x, int32_t y,
             uint32_t buttons, uint32_t button, int32_t dx, int32_t dy) {
    if (!vm_alive(c)) return VM_TARGET_LOST;
    if (c->uncertain) return VM_CONFLICT;
    int release_only = kind == (VM_UP | 0x100u);
    if (release_only) kind = VM_UP;
    if (x < -32768 || x > 32767 || y < -32768 || y > 32767 || buttons > 31 ||
        kind < VM_MOVE || kind > VM_WHEEL ||
        ((kind == VM_DOWN || kind == VM_UP) && button != 1 && button != 2 && button != 4 && button != 8 && button != 16)) return VM_INVALID;
    if (c->shared) {
        VmShared *s = c->shared;
        s->release_only = release_only; s->event_kind = kind; s->x = x; s->y = y; s->buttons = buttons;
        s->button = button; s->delta_x = dx; s->delta_y = dy;
        InterlockedExchange(&s->ack, 0);
        int result = send_control(c, c->token, VM_EVENT);
        if (result == VM_OK && s->ack == VM_READY) return VM_OK;
        return s->ack >= VM_INVALID && s->ack <= VM_DELIVERY_FAILED ? (int)s->ack : (result == VM_OK ? VM_DELIVERY_FAILED : result);
    }
    if (c->uncertain) return VM_CONFLICT;
    WPARAM flags = vm_button_flags(buttons);
    LPARAM point = MAKELPARAM((SHORT)x, (SHORT)y);
    if (kind == VM_MOVE) return send_event(c, WM_MOUSEMOVE, flags, point);
    if (kind == VM_DOWN || kind == VM_UP) {
        if (button == 8 || button == 16) flags |= (WPARAM)(button == 8 ? XBUTTON1 : XBUTTON2) << 16;
        return send_event(c, vm_button_message(button, kind == VM_DOWN), flags, point);
    }
    POINT screen = {x, y};
    if (!client_to_screen(c->hwnd, &screen) || screen.x < -32768 || screen.x > 32767 ||
        screen.y < -32768 || screen.y > 32767) return VM_INVALID;
    point = MAKELPARAM((SHORT)screen.x, (SHORT)screen.y);
    int result = VM_OK;
    if (dy) result = send_event(c, WM_MOUSEWHEEL, flags | ((WPARAM)(WORD)(SHORT)dy << 16), point);
    if (result == VM_OK && dx) result = send_event(c, WM_MOUSEHWHEEL, flags | ((WPARAM)(WORD)(SHORT)dx << 16), point);
    return result;
}

int vm_is_intercepting(VmClient *c) { return c && c->intercepting; }
void vm_close(VmClient *c) {
    if (!c) return;
    vm_begin(c, c->timeout_ms);
    if (c->shared) InterlockedExchange(&c->shared->enabled, 0);
    if (IsWindow(c->hwnd) && (uintptr_t)GetPropW(c->hwnd, VM_OWNER_PROPERTY) == c->token) {
        // Geometry loss must not skip resource removal. The shared enabled flag
        // is already cleared even if the receiver cannot acknowledge detach.
        if (c->shared) (void)send_control(c, c->token, VM_DETACH);
        HANDLE gate = lock_target(c->hwnd, c->timeout_ms);
        if (gate) {
            if ((uintptr_t)GetPropW(c->hwnd, VM_OWNER_PROPERTY) == c->token) {
                RemovePropW(c->hwnd, VM_OWNER_PROPERTY); RemovePropW(c->hwnd, VM_OWNER_TIME_PROPERTY);
            }
            unlock_target(gate);
        }
    }
    close_mapping(c);
    HeapFree(GetProcessHeap(), 0, c);
}
