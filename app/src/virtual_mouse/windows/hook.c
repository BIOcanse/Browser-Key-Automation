#define _WIN32_WINNT 0x0601
#include "wire.h"
#include <commctrl.h>
#include "MinHook.h"

typedef struct VmTarget {
    HANDLE mapping, owner;
    VmShared *shared;
    HWND hwnd;
    UINT control;
    unsigned dispatching, retired;
} VmTarget;

/* Use the C11 storage specifier: __declspec(thread) was ignored by the GNU
   target and silently made this process-global, racing Chromium UI threads. */
static _Thread_local VmTarget *scope;
static _Thread_local int physical_keyboard_scope;
static SRWLOCK hooks_lock = SRWLOCK_INIT;
static unsigned hooks_users;
static int hooks_initialized;
static BOOL (WINAPI *real_cursor)(LPPOINT);
static BOOL (WINAPI *real_cursor_info)(PCURSORINFO);
static HWND (WINAPI *real_window_from_point)(POINT);
static SHORT (WINAPI *real_key)(int);
static SHORT (WINAPI *real_async_key)(int);
static BOOL (WINAPI *real_keyboard_state)(PBYTE);
static BOOL (WINAPI *real_set_keyboard_state)(LPBYTE);
static DWORD (WINAPI *real_message_pos)(void);
static BOOL (WINAPI *real_set_cursor)(int, int);
static BOOL (WINAPI *real_set_foreground)(HWND);
static BOOL (WINAPI *real_window_pos)(HWND, HWND, int, int, int, int, UINT);
static HWND (WINAPI *real_set_capture)(HWND);
static HWND (WINAPI *real_get_capture)(void);
static BOOL (WINAPI *real_release_capture)(void);
static LRESULT (WINAPI *real_send_w)(HWND, UINT, WPARAM, LPARAM);
static LRESULT (WINAPI *real_send_a)(HWND, UINT, WPARAM, LPARAM);
static LRESULT (WINAPI *real_timeout_w)(HWND, UINT, WPARAM, LPARAM, UINT, UINT, PDWORD_PTR);
static LRESULT (WINAPI *real_timeout_a)(HWND, UINT, WPARAM, LPARAM, UINT, UINT, PDWORD_PTR);

/* A nested SendMessage to another HWND is a different recipient, even on the
   same UI thread. It must not inherit the outer virtual input snapshot. */
#define SEND_WRAPPER(suffix) \
static LRESULT WINAPI hooked_send_##suffix(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) { \
    VmTarget *previous = scope; if (scope && hwnd != scope->hwnd) scope = NULL; \
    LRESULT result = real_send_##suffix(hwnd, msg, wp, lp); scope = previous; return result; \
} \
static LRESULT WINAPI hooked_timeout_##suffix(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp, UINT flags, UINT timeout, PDWORD_PTR out) { \
    VmTarget *previous = scope; if (scope && hwnd != scope->hwnd) scope = NULL; \
    LRESULT result = real_timeout_##suffix(hwnd, msg, wp, lp, flags, timeout, out); scope = previous; return result; \
}
SEND_WRAPPER(w)
SEND_WRAPPER(a)
#undef SEND_WRAPPER

static int active(VmTarget *t) {
    return t && InterlockedCompareExchange(&t->shared->enabled, 0, 0) &&
           WaitForSingleObject(t->owner, 0) == WAIT_TIMEOUT &&
           (uintptr_t)GetPropW(t->hwnd, VM_OWNER_PROPERTY) == t->shared->token;
}
static int virtual_point(POINT *p) {
    if (!scope || !active(scope) || !p) return 0;
    p->x = scope->shared->x; p->y = scope->shared->y;
    return ClientToScreen(scope->hwnd, p);
}
static BOOL WINAPI hooked_cursor(LPPOINT p) {
    return virtual_point(p) ? TRUE : real_cursor(p);
}
static BOOL WINAPI hooked_cursor_info(PCURSORINFO info) {
    BOOL result = real_cursor_info(info);
    if (result && info) { POINT p; if (virtual_point(&p)) info->ptScreenPos = p; }
    return result;
}
static HWND WINAPI hooked_window_from_point(POINT point) {
    POINT cursor;
    /* Cursor hit testing must refer to the same owned snapshot, not a window
       covering the virtual target. Unrelated coordinates retain real hit tests. */
    if (virtual_point(&cursor) && point.x == cursor.x && point.y == cursor.y) return scope->hwnd;
    /* Real hit testing can reenter another same-thread HWND via WM_NCHITTEST. */
    VmTarget *previous = scope; scope = NULL;
    HWND result = real_window_from_point(point);
    scope = previous;
    return result;
}
static unsigned button_mask(int key) {
    switch (key) {
        case VK_LBUTTON: return 1;
        case VK_RBUTTON: return 2;
        case VK_MBUTTON: return 4;
        case VK_XBUTTON1: return 8;
        case VK_XBUTTON2: return 16;
        default: return 0;
    }
}
static SHORT WINAPI hooked_key(int key) {
    unsigned bit = button_mask(key);
    if (bit && active(scope)) return (scope->shared->buttons & bit) ? (SHORT)0x8000 : 0;
    if (key >= 0 && key < 256 && active(scope) && !physical_keyboard_scope) return (SHORT)(((scope->shared->keys[key] & 0x80) << 8) | (scope->shared->keys[key] & 1));
    return real_key(key);
}
static SHORT WINAPI hooked_async_key(int key) {
    unsigned bit = button_mask(key);
    if (bit && active(scope)) return (scope->shared->buttons & bit) ? (SHORT)0x8000 : 0;
    if (key >= 0 && key < 256 && active(scope) && !physical_keyboard_scope) return (SHORT)((scope->shared->keys[key] & 0x80) << 8);
    return real_async_key(key);
}
static BOOL WINAPI hooked_keyboard_state(PBYTE keys) {
    if (!active(scope)) return real_keyboard_state(keys);
    if (!keys) return FALSE;
    if (physical_keyboard_scope) {
        if (!real_keyboard_state(keys)) return FALSE;
    } else memcpy(keys, scope->shared->keys, 256);
    for (int key = 1; key < 7; ++key) {
        unsigned bit = button_mask(key);
        if (bit) keys[key] = (scope->shared->buttons & bit) ? 0x80 : 0;
    }
    return TRUE;
}
static BOOL WINAPI hooked_set_keyboard_state(LPBYTE keys) {
    /* A consumer may save our virtual table and later restore it (Chromium's
       keyboard-layout initialization does). It must not write that snapshot
       into the real thread's keyboard table. The App owns virtual state. */
    if (active(scope)) { SetLastError(ERROR_NOT_SUPPORTED); return FALSE; }
    return real_set_keyboard_state(keys);
}
static DWORD WINAPI hooked_message_pos(void) {
    POINT p;
    return virtual_point(&p) ? (DWORD)MAKELPARAM((SHORT)p.x, (SHORT)p.y) : real_message_pos();
}
static BOOL WINAPI hooked_set_cursor(int x, int y) {
    if (active(scope)) { SetLastError(ERROR_NOT_SUPPORTED); return FALSE; }
    return real_set_cursor(x, y);
}
static BOOL WINAPI hooked_set_foreground(HWND hwnd) {
    // A virtual callback may ask to activate its browser as part of handling a
    // mouse press. That is not permission to change the user's OS foreground.
    // Explicit real-keyboard delivery retains normal native behavior.
    if (active(scope) && !physical_keyboard_scope) { SetLastError(ERROR_NOT_SUPPORTED); return FALSE; }
    return real_set_foreground(hwnd);
}
static BOOL WINAPI hooked_window_pos(HWND hwnd, HWND after, int x, int y, int cx, int cy, UINT flags) {
    if (active(scope) && !physical_keyboard_scope) {
        flags |= SWP_NOACTIVATE;
        if (hwnd == GetAncestor(scope->hwnd, GA_ROOT)) flags |= SWP_NOZORDER | SWP_NOOWNERZORDER;
    }
    // Window-manager positioning callbacks bypass the SendMessage exports.
    // Apply the outer call's positioning policy, but do not lend its input
    // snapshot to a different recipient during the native call.
    VmTarget *previous = scope;
    if (scope && hwnd != scope->hwnd) scope = NULL;
    BOOL result = real_window_pos(hwnd, after, x, y, cx, cy, flags);
    scope = previous;
    return result;
}
static HWND WINAPI hooked_set_capture(HWND hwnd) {
    if (active(scope)) {
        HWND previous = scope->shared->captured ? scope->hwnd : NULL;
        if (hwnd == scope->hwnd) scope->shared->captured = 1;
        return previous;
    }
    return real_set_capture(hwnd);
}
static HWND WINAPI hooked_get_capture(void) {
    return active(scope) ? (scope->shared->captured ? scope->hwnd : NULL) : real_get_capture();
}
static BOOL WINAPI hooked_release_capture(void) {
    if (active(scope)) { scope->shared->captured = 0; return TRUE; }
    return real_release_capture();
}

static int retain_hooks(void) {
    AcquireSRWLockExclusive(&hooks_lock);
    if (hooks_users) { ++hooks_users; ReleaseSRWLockExclusive(&hooks_lock); return 1; }
    if (hooks_initialized) {
        int ready = MH_EnableHook(MH_ALL_HOOKS) == MH_OK;
        if (ready) hooks_users = 1;
        else MH_DisableHook(MH_ALL_HOOKS);
        ReleaseSRWLockExclusive(&hooks_lock);
        return ready;
    }
    HMODULE pinned;
    /* Window subclass callbacks outlive the bootstrap hook. Retain the module
       until target exit; detached contexts have no active interception. */
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
                           (LPCWSTR)&retain_hooks, &pinned)) goto unavailable;
    if (MH_Initialize() != MH_OK) goto unavailable;
#define ADD_HOOK(name, replacement, original) \
    if (MH_CreateHookApi(L"user32.dll", name, (LPVOID)replacement, (LPVOID *)&original) != MH_OK) goto failed
    ADD_HOOK("GetCursorPos", hooked_cursor, real_cursor);
    ADD_HOOK("GetCursorInfo", hooked_cursor_info, real_cursor_info);
    ADD_HOOK("WindowFromPoint", hooked_window_from_point, real_window_from_point);
    ADD_HOOK("GetKeyState", hooked_key, real_key);
    ADD_HOOK("GetAsyncKeyState", hooked_async_key, real_async_key);
    ADD_HOOK("GetKeyboardState", hooked_keyboard_state, real_keyboard_state);
    ADD_HOOK("SetKeyboardState", hooked_set_keyboard_state, real_set_keyboard_state);
    ADD_HOOK("GetMessagePos", hooked_message_pos, real_message_pos);
    ADD_HOOK("SetCursorPos", hooked_set_cursor, real_set_cursor);
    ADD_HOOK("SetForegroundWindow", hooked_set_foreground, real_set_foreground);
    ADD_HOOK("SetWindowPos", hooked_window_pos, real_window_pos);
    ADD_HOOK("SetCapture", hooked_set_capture, real_set_capture);
    ADD_HOOK("GetCapture", hooked_get_capture, real_get_capture);
    ADD_HOOK("ReleaseCapture", hooked_release_capture, real_release_capture);
    ADD_HOOK("SendMessageW", hooked_send_w, real_send_w);
    ADD_HOOK("SendMessageA", hooked_send_a, real_send_a);
    ADD_HOOK("SendMessageTimeoutW", hooked_timeout_w, real_timeout_w);
    ADD_HOOK("SendMessageTimeoutA", hooked_timeout_a, real_timeout_a);
#undef ADD_HOOK
    hooks_initialized = 1;
    /* A partial activation has already exposed detours to other threads. Keep
       all trampolines alive even when a later patch could not be enabled. */
    if (MH_EnableHook(MH_ALL_HOOKS) != MH_OK) {
        MH_DisableHook(MH_ALL_HOOKS);
        goto unavailable;
    }
    hooks_users = 1;
    ReleaseSRWLockExclusive(&hooks_lock);
    return 1;
failed:
    MH_Uninitialize();
unavailable:
    ReleaseSRWLockExclusive(&hooks_lock);
    return 0;
}
static void release_hooks(void) {
    AcquireSRWLockExclusive(&hooks_lock);
    // A thread can be inside a detour immediately before calling its original
    // trampoline. Disable patches now, but retain that bounded trampoline memory
    // with the pinned DLL until process exit; an in-flight call stays valid.
    if (hooks_users && --hooks_users == 0) MH_DisableHook(MH_ALL_HOOKS);
    ReleaseSRWLockExclusive(&hooks_lock);
}

static int is_mouse_message(UINT message) {
    return (message >= WM_MOUSEFIRST && message <= WM_MOUSELAST) ||
           message == WM_MOUSEHOVER || message == WM_MOUSELEAVE;
}
static void free_target(VmTarget *t) {
    InterlockedExchange(&t->shared->enabled, 0);
    /* Only the client claim protocol removes ownership properties. A dead
       owner's reclaimable property must not race with a new client's claim. */
    UnmapViewOfFile(t->shared);
    CloseHandle(t->mapping);
    CloseHandle(t->owner);
    HeapFree(GetProcessHeap(), 0, t);
    release_hooks();
}
static int deliver(VmTarget *t) {
    VmShared *s = t->shared;
    if (s->event_kind == VM_KEY_DOWN || s->event_kind == VM_KEY_UP) {
        int down = s->event_kind == VM_KEY_DOWN;
        int alt = (s->keys[VK_MENU] & 0x80) || s->key_vk == VK_LMENU || s->key_vk == VK_RMENU;
        HKL layout = GetKeyboardLayout(0);
        UINT scan = MapVirtualKeyExW(s->key_vk, MAPVK_VK_TO_VSC, layout);
        LPARAM bits = 1 | ((LPARAM)(scan & 0xff) << 16) | ((LPARAM)s->key_extended << 24) |
            (alt ? (1L << 29) : 0) | (down ? 0 : ((LPARAM)3 << 30));
        DefSubclassProc(t->hwnd, alt ? (down ? WM_SYSKEYDOWN : WM_SYSKEYUP) : (down ? WM_KEYDOWN : WM_KEYUP), s->key_vk, bits);
        if (down && IsWindow(t->hwnd)) {
            WCHAR text[8];
            int count = ToUnicodeEx(s->key_vk, scan, s->keys, text, 8, 4, layout);
            for (int i = 0; i < count && IsWindow(t->hwnd); ++i) DefSubclassProc(t->hwnd, alt ? WM_SYSCHAR : WM_CHAR, text[i], bits);
        }
        return IsWindow(t->hwnd) ? VM_OK : VM_TARGET_LOST;
    }
    WPARAM flags = vm_button_flags(s->buttons);
    if (s->keys[VK_SHIFT] & 0x80) flags |= MK_SHIFT;
    if (s->keys[VK_CONTROL] & 0x80) flags |= MK_CONTROL;
    LPARAM point = MAKELPARAM((SHORT)s->x, (SHORT)s->y);
    if (s->event_kind == VM_MOVE) { DefSubclassProc(t->hwnd, WM_MOUSEMOVE, flags, point); return VM_OK; }
    if (s->event_kind == VM_DOWN || s->event_kind == VM_UP) {
        if (s->button == 8 || s->button == 16) flags |= (WPARAM)(s->button == 8 ? XBUTTON1 : XBUTTON2) << 16;
        DefSubclassProc(t->hwnd, vm_button_message(s->button, s->event_kind == VM_DOWN), flags, point);
        return VM_OK;
    }
    POINT p = {s->x, s->y};
    if (!ClientToScreen(t->hwnd, &p) || p.x < -32768 || p.x > 32767 || p.y < -32768 || p.y > 32767) return VM_INVALID;
    point = MAKELPARAM((SHORT)p.x, (SHORT)p.y);
    if (s->delta_y) DefSubclassProc(t->hwnd, WM_MOUSEWHEEL, flags | ((WPARAM)(WORD)(SHORT)s->delta_y << 16), point);
    if (s->delta_x) {
        if (!IsWindow(t->hwnd)) return VM_TARGET_LOST;
        DefSubclassProc(t->hwnd, WM_MOUSEHWHEEL, flags | ((WPARAM)(WORD)(SHORT)s->delta_x << 16), point);
    }
    return VM_OK;
}

static LRESULT CALLBACK target_proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam,
                                     UINT_PTR id, DWORD_PTR data) {
    VmTarget *t = (VmTarget *)data;
    if (message == t->control && wparam == t->shared->token) {
        if (lparam == VM_DETACH) {
            RemoveWindowSubclass(hwnd, target_proc, id);
            t->retired = 1;
            if (!t->dispatching) free_target(t);
            return VM_READY;
        }
        if (lparam == VM_EVENT && active(t)) {
            VmTarget *previous = scope;
            int previous_keyboard = physical_keyboard_scope;
            scope = t;
            physical_keyboard_scope = 0;
            ++t->dispatching;
            int result = deliver(t);
            --t->dispatching;
            scope = previous;
            physical_keyboard_scope = previous_keyboard;
            InterlockedExchange(&t->shared->ack, result == VM_OK ? VM_READY : result);
            if (t->retired && !t->dispatching) free_target(t);
            return result == VM_OK ? VM_READY : result;
        }
    }
    if (message == WM_NCDESTROY) {
        RemoveWindowSubclass(hwnd, target_proc, id);
        /* A target can destroy itself inside a virtual callback. Defer freeing
           its shared packet until that callback returns. */
        InterlockedExchange(&t->shared->enabled, 0);
        t->retired = 1;
        LRESULT result = DefSubclassProc(hwnd, message, wparam, lparam);
        if (!t->dispatching) free_target(t);
        return result;
    }
    if (!active(t)) {
        RemoveWindowSubclass(hwnd, target_proc, id);
        t->retired = 1;
        LRESULT result = DefSubclassProc(hwnd, message, wparam, lparam);
        if (!t->dispatching) free_target(t);
        return result;
    }
    int keyboard = message >= WM_KEYFIRST && message <= WM_KEYLAST;
    if (is_mouse_message(message) || keyboard) {
        if (t->shared->source_tag && (uintptr_t)GetMessageExtraInfo() == t->shared->source_tag) {
            VmTarget *previous = scope;
            int previous_keyboard = physical_keyboard_scope;
            scope = t;
            // SendInput is queued, unlike VM_EVENT. Its keyboard queries must
            // use the OS message-time table, not the App's later logical state.
            physical_keyboard_scope = keyboard;
            ++t->dispatching;
            LRESULT result = DefSubclassProc(hwnd, message, wparam, lparam);
            --t->dispatching;
            scope = previous;
            physical_keyboard_scope = previous_keyboard;
            if (t->retired && !t->dispatching) free_target(t);
            return result;
        }
        if (InterlockedCompareExchange(&t->shared->filter_input, 0, 0)) return 0;
    }
    if (message == t->control && lparam == VM_ATTACH) return VM_READY;
    return DefSubclassProc(hwnd, message, wparam, lparam);
}

__declspec(dllexport) LRESULT CALLBACK VmBootstrap(int code, WPARAM wparam, LPARAM lparam) {
    if (code >= 0) {
        const CWPSTRUCT *message = (const CWPSTRUCT *)lparam;
        UINT control = RegisterWindowMessageW(VM_CONTROL_NAME);
        if (message->message == control && message->lParam == VM_ATTACH && message->wParam <= 0xffff) {
            wchar_t name[128];
            if (GlobalGetAtomNameW((ATOM)message->wParam, name, 128)) {
                HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name);
                VmShared *s = mapping ? MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(VmShared)) : NULL;
                if (s && s->magic == VM_MAGIC && s->bytes == sizeof(VmShared) &&
                    s->target_pid == GetCurrentProcessId() && s->target_tid == GetCurrentThreadId() &&
                    s->target_hwnd == (uintptr_t)message->hwnd &&
                    (uintptr_t)GetPropW(message->hwnd, VM_OWNER_PROPERTY) == s->token && s->enabled && s->ack != VM_READY) {
                    int retained = retain_hooks();
                    HANDLE owner = retained ? OpenProcess(SYNCHRONIZE, FALSE, s->owner_pid) : NULL;
                    VmTarget *t = owner ? HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*t)) : NULL;
                    if (t) {
                        *t = (VmTarget){ .mapping = mapping, .shared = s, .owner = owner,
                                         .hwnd = message->hwnd, .control = control };
                        if (SetWindowSubclass(t->hwnd, target_proc, s->token, (DWORD_PTR)t)) {
                            InterlockedExchange(&s->ack, VM_READY);
                            retained = 0;
                            s = NULL; mapping = NULL; owner = NULL; t = NULL;
                        }
                    }
                    if (t) HeapFree(GetProcessHeap(), 0, t);
                    if (owner) CloseHandle(owner);
                    if (retained) release_hooks();
                }
                if (s) UnmapViewOfFile(s);
                if (mapping) CloseHandle(mapping);
            }
        }
    }
    return CallNextHookEx(NULL, code, wparam, lparam);
}
