#include "wire.h"

typedef struct RrContext { HANDLE mapping, owner; RrShared *shared; LONG bit; } RrContext;
static _Thread_local RrContext *context;
static _Thread_local unsigned observing;

static void close_context(void) {
    RrContext *old = context; context = NULL;
    if (!old) return;
    CloseHandle(old->owner); UnmapViewOfFile(old->shared); CloseHandle(old->mapping);
    HeapFree(GetProcessHeap(), 0, old);
}

static int valid(RrContext *c) {
    DWORD pid = 0;
    HWND root = (HWND)c->shared->root;
    return WaitForSingleObject(c->owner, 0) == WAIT_TIMEOUT && IsWindow(root) &&
        GetWindowThreadProcessId(root, &pid) && pid == c->shared->target_pid &&
        (uintptr_t)GetPropW(root, RR_OWNER) == c->shared->token &&
        (uint64_t)(uintptr_t)GetPropW(root, RR_OWNER_TIME) == c->shared->owner_created;
}

static int geometry(RrShared *s, RrEvent *event) {
    HWND root = (HWND)s->root;
    RECT client;
    if (!GetWindowRect(root, &event->window) || !GetClientRect(root, &client)) return 0;
    POINT origin = {client.left, client.top};
    if (!ClientToScreen(root, &origin)) return 0;
    event->client_screen = (RECT){origin.x, origin.y, origin.x + client.right - client.left, origin.y + client.bottom - client.top};
    event->dpi = GetDpiForWindow(root);
    event->visible = IsWindowVisible(root) != 0; event->iconic = IsIconic(root) != 0;
    return event->dpi != 0;
}

static void publish(RrShared *s, RrEvent event) {
    if (!InterlockedCompareExchange(&s->enabled, 0, 0)) return;
    LONG index = InterlockedIncrement(&s->next) - 1;
    if (index >= RR_CAPACITY) {
        InterlockedIncrement(&s->lost); InterlockedExchange(&s->enabled, 0); return;
    }
    event.sequence = (uint32_t)index + 1;
    /* Each producer owns one slot; readers require the final release publish. */
    s->events[index] = event;
    InterlockedExchange(&s->events[index].committed, 1);
}

static int mouse_message(UINT message) {
    return (message >= WM_MOUSEFIRST && message <= WM_MOUSELAST) ||
        (message >= WM_NCMOUSEMOVE && message <= WM_NCXBUTTONDBLCLK);
}
static int keyboard_message(UINT message) { return message >= WM_KEYFIRST && message <= WM_KEYLAST; }

static void observe(HWND hwnd, UINT message, WPARAM wp, LPARAM lp, uint32_t phase, DWORD message_time) {
    RrContext *c = context;
    if (!c || observing) return;
    if (!valid(c)) { close_context(); return; }
    RrShared *s = c->shared;
    if (!InterlockedCompareExchange(&s->enabled, 0, 0)) return;
    DWORD pid = 0;
    if (GetWindowThreadProcessId(hwnd, &pid) != GetCurrentThreadId() || pid != s->target_pid ||
        GetAncestor(hwnd, GA_ROOT) != (HWND)s->root) return;
    int is_mouse = mouse_message(message), is_key = keyboard_message(message);
    int is_window = hwnd == (HWND)s->root && (message == WM_WINDOWPOSCHANGED || message == WM_SIZE ||
        message == WM_SHOWWINDOW || message == WM_DPICHANGED || message == WM_NCDESTROY);
    if (phase == RR_QUEUE_REMOVE_PHASE ? !(is_mouse || is_key) : phase != RR_CONTROL_PHASE && !is_window) return;
    ++observing; InterlockedIncrement(&s->callbacks);
    DPI_AWARENESS_CONTEXT previous = SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext((HWND)s->root));
    RrEvent event = { .kind = phase == RR_CONTROL_PHASE ? RR_BASELINE : is_window ? RR_WINDOW : RR_INPUT,
        .phase = phase, .message = message, .tid = GetCurrentThreadId(), .message_time = message_time, .hwnd = (uintptr_t)hwnd };
    LARGE_INTEGER tick; QueryPerformanceCounter(&tick); event.qpc = tick.QuadPart;
    if (!geometry(s, &event)) { InterlockedIncrement(&s->lost); InterlockedExchange(&s->enabled, 0); goto done; }
    if (is_mouse) {
        POINT point = {(SHORT)LOWORD(lp), (SHORT)HIWORD(lp)};
        if (!(message == WM_MOUSEWHEEL || message == WM_MOUSEHWHEEL ||
              message >= WM_NCMOUSEMOVE && message <= WM_NCXBUTTONDBLCLK) && !ClientToScreen(hwnd, &point)) {
            InterlockedIncrement(&s->lost); InterlockedExchange(&s->enabled, 0); goto done;
        }
        int inside = !event.iconic && point.x >= event.window.left && point.x < event.window.right &&
            point.y >= event.window.top && point.y < event.window.bottom;
        LONG before = InterlockedExchange(&s->mouse_inside, inside);
        if (!inside) {
            if (before == 1) { event.kind = RR_EXIT; publish(s, event); }
            goto done; /* Outside coordinates never enter shared memory or logs. */
        }
        event.point_valid = 1; event.x = point.x; event.y = point.y;
        if (before != 1) { RrEvent entered = event; entered.kind = RR_ENTER; publish(s, entered); }
        event.wparam = wp;
    } else if (is_key) {
        event.wparam = wp; event.key_lparam = (uintptr_t)lp;
        event.keyboard_layout = (uintptr_t)GetKeyboardLayout(0);
    } else if (is_window) {
        event.wparam = wp;
        if (message == WM_WINDOWPOSCHANGED && lp) {
            WINDOWPOS position = *(WINDOWPOS *)lp;
            event.position_x = position.x; event.position_y = position.y;
            event.position_width = position.cx; event.position_height = position.cy;
            event.position_flags = position.flags;
        } else if (message == WM_DPICHANGED && lp) event.suggested_rect = *(RECT *)lp;
    }
    publish(s, event);
    if (message == WM_NCDESTROY) InterlockedExchange(&s->enabled, 0);
done:
    if (previous) SetThreadDpiAwarenessContext(previous);
    InterlockedDecrement(&s->callbacks); --observing;
}

static void attach(const CWPSTRUCT *message) {
    if (context || message->wParam > 0xffff) return;
    wchar_t name[128];
    if (!GlobalGetAtomNameW((ATOM)message->wParam, name, 128)) return;
    HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name);
    RrShared *s = mapping ? MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(*s)) : NULL;
    HANDLE owner = NULL;
    LONG bit = 0;
    if (s && s->magic == RR_MAGIC && s->bytes == sizeof(*s) && s->thread_count <= RR_THREADS &&
        s->target_pid == GetCurrentProcessId() && GetAncestor(message->hwnd, GA_ROOT) == (HWND)s->root &&
        (uintptr_t)GetPropW((HWND)s->root, RR_OWNER) == s->token && s->enabled) {
        for (uint32_t i = 0; i < s->thread_count; ++i) if (s->thread_ids[i] == GetCurrentThreadId()) bit = 1 << i;
        owner = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, s->owner_pid);
    }
    if (bit && owner && rr_created(owner) == s->owner_created && WaitForSingleObject(owner, 0) == WAIT_TIMEOUT) {
        RrContext *c = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*c));
        if (c) {
            *c = (RrContext){mapping, owner, s, bit}; context = c;
            InterlockedOr(&s->attached, bit);
            observe(message->hwnd, 0, 0, 0, RR_CONTROL_PHASE, 0);
            mapping = NULL; owner = NULL; s = NULL;
        }
    }
    if (owner) CloseHandle(owner);
    if (s) UnmapViewOfFile(s);
    if (mapping) CloseHandle(mapping);
}

__declspec(dllexport) LRESULT CALLBACK RrWindowHook(int code, WPARAM wp, LPARAM lp) {
    if (code >= 0) {
        const CWPSTRUCT *message = (const CWPSTRUCT *)lp;
        if (message->message == RegisterWindowMessageW(RR_CONTROL)) {
            if (message->lParam == RR_ATTACH) attach(message);
            else if (message->lParam == RR_DETACH && context && message->wParam == context->shared->token) {
                InterlockedOr(&context->shared->detached, context->bit); close_context();
            }
        } else observe(message->hwnd, message->message, message->wParam, message->lParam, RR_SENT_WINDOW_PHASE, 0);
    }
    return CallNextHookEx(NULL, code, wp, lp);
}

__declspec(dllexport) LRESULT CALLBACK RrQueueHook(int code, WPARAM wp, LPARAM lp) {
    if (code >= 0 && wp == PM_REMOVE) {
        const MSG *message = (const MSG *)lp;
        observe(message->hwnd, message->message, message->wParam, message->lParam, RR_QUEUE_REMOVE_PHASE, message->time);
    }
    return CallNextHookEx(NULL, code, wp, lp);
}
