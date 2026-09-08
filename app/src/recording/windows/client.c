#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "client.h"

/* The external App owns observation and the ring. No browser DLL or child
   window inventory. The worker serializes callbacks; readers only acknowledge. */
struct RcClient {
    SRWLOCK lock;
    HWND root;
    DWORD pid, tid;
    HANDLE thread, ready, stop;
    ATOM identity;
    RcEvent *events;
    uint32_t capacity, duration_ms, delivered;
    RcStatus status;
    unsigned char keys[256];
    int inside;
};
static _Thread_local RcClient *current;
static int alive(RcClient *c) {
    DWORD pid = 0;
    return IsWindow(c->root) && GetWindowThreadProcessId(c->root, &pid) == c->tid && pid == c->pid &&
        GetPropW(c->root, MAKEINTATOM(c->identity)) == (HANDLE)c;
}
static int geometry(RcClient *c, RcEvent *e) {
    RECT r, client; POINT origin = {0, 0}; LARGE_INTEGER now;
    if (!alive(c) || !GetWindowRect(c->root, &r) || !GetClientRect(c->root, &client) || !ClientToScreen(c->root, &origin)) return 0;
    QueryPerformanceCounter(&now); e->qpc = now.QuadPart;
    e->hwnd = (uintptr_t)c->root; e->tid = c->tid; e->dpi = GetDpiForWindow(c->root);
    e->window = (RcRect){r.left, r.top, r.right, r.bottom};
    e->client_screen = (RcRect){origin.x, origin.y, origin.x + client.right, origin.y + client.bottom};
    e->visible = IsWindowVisible(c->root) != 0; e->iconic = IsIconic(c->root) != 0;
    e->position_flags = IsZoomed(c->root) ? 1 : 0;
    return 1;
}
static void end(RcClient *c, uint32_t reason) {
    AcquireSRWLockExclusive(&c->lock);
    if (c->status.reason == RC_RUNNING) c->status.reason = reason;
    ReleaseSRWLockExclusive(&c->lock); SetEvent(c->stop);
}
static void append(RcClient *c, RcEvent *e) {
    AcquireSRWLockExclusive(&c->lock);
    if (c->status.reason == RC_RUNNING) {
        if (c->status.reserved - c->status.acknowledged == c->capacity) {
            c->status.lost++; c->status.reason = RC_OVERFLOW; SetEvent(c->stop);
        } else {
            e->sequence = ++c->status.reserved;
            c->events[(e->sequence - 1) % c->capacity] = *e;
            c->status.geometry = *e; c->status.geometry.point_valid = 0;
            c->status.geometry.x = c->status.geometry.y = 0; c->status.geometry_valid = 1;
        }
    }
    ReleaseSRWLockExclusive(&c->lock);
}
static void record_mouse(RcClient *c, UINT message, const MSLLHOOKSTRUCT *input) {
    RcEvent e = {0};
    if (!geometry(c, &e)) { end(c, RC_TARGET_LOST); return; }
    HWND hit = WindowFromPoint(input->pt);
    int inside = e.visible && !e.iconic && input->pt.x >= e.window.left && input->pt.x < e.window.right &&
        input->pt.y >= e.window.top && input->pt.y < e.window.bottom && hit && GetAncestor(hit, GA_ROOT) == c->root;
    e.phase = RC_LOW_LEVEL_PHASE; e.message_time = input->time;
    if (!inside) {
        if (c->inside) { e.kind = RC_EXIT; append(c, &e); }
        c->inside = 0; return;
    }
    c->inside = 1; e.kind = RC_INPUT; e.message = message; e.point_valid = 1;
    /* No off-window coordinate ever enters the buffer. */
    e.x = input->pt.x - e.window.left; e.y = input->pt.y - e.window.top;
    e.wparam = input->mouseData & 0xffff0000u; /* signed wheel delta or XBUTTON1/2 */
    append(c, &e);
}
static LRESULT CALLBACK mouse_hook(int code, WPARAM message, LPARAM value) {
    if (code == HC_ACTION && current) record_mouse(current, (UINT)message, (const MSLLHOOKSTRUCT *)value);
    return CallNextHookEx(NULL, code, message, value);
}
static LRESULT CALLBACK keyboard_hook(int code, WPARAM message, LPARAM value) {
    RcClient *c = current;
    if (code == HC_ACTION && c) {
        const KBDLLHOOKSTRUCT *input = (const KBDLLHOOKSTRUCT *)value;
        if (input->vkCode < 256) {
            int up = (input->flags & LLKHF_UP) != 0;
            int held = c->keys[input->vkCode];
            c->keys[input->vkCode] = !up;
            if (GetForegroundWindow() != c->root) return CallNextHookEx(NULL, code, message, value);
            RcEvent e = {0};
            if (!geometry(c, &e)) end(c, RC_TARGET_LOST);
            else {
                e.kind = RC_INPUT; e.phase = RC_LOW_LEVEL_PHASE; e.message = (UINT)message;
                e.message_time = input->time; e.wparam = input->vkCode; e.keyboard_layout = (uintptr_t)GetKeyboardLayout(c->tid);
                e.key_lparam = 1u | ((input->scanCode & 0xffu) << 16) |
                    ((input->flags & LLKHF_EXTENDED) ? 0x01000000u : 0) | ((input->flags & LLKHF_ALTDOWN) ? 0x20000000u : 0) |
                    ((up || held) ? 0x40000000u : 0) | (up ? 0x80000000u : 0);
                append(c, &e);
            }
        }
    }
    return CallNextHookEx(NULL, code, message, value);
}
static void CALLBACK window_hook(HWINEVENTHOOK hook, DWORD event, HWND hwnd, LONG object, LONG child, DWORD thread, DWORD time) {
    (void)hook; (void)child; (void)thread; RcClient *c = current;
    if (!c || hwnd != c->root || object != OBJID_WINDOW) return;
    if (event == EVENT_OBJECT_DESTROY) { end(c, RC_TARGET_LOST); return; }
    if (event != EVENT_OBJECT_LOCATIONCHANGE && event != EVENT_OBJECT_SHOW && event != EVENT_OBJECT_HIDE &&
        event != EVENT_SYSTEM_MINIMIZESTART && event != EVENT_SYSTEM_MINIMIZEEND) return;
    RcEvent e = {0};
    if (!geometry(c, &e)) { end(c, RC_TARGET_LOST); return; }
    e.kind = RC_WINDOW; e.phase = RC_WIN_EVENT_PHASE; e.message = event; e.message_time = time; append(c, &e);
}
static DWORD WINAPI observe(void *parameter) {
    RcClient *c = parameter; current = c;
    SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    HHOOK mouse = SetWindowsHookExW(WH_MOUSE_LL, mouse_hook, GetModuleHandleW(NULL), 0);
    HHOOK keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, keyboard_hook, GetModuleHandleW(NULL), 0);
    HWINEVENTHOOK windows = SetWinEventHook(EVENT_OBJECT_DESTROY, EVENT_OBJECT_LOCATIONCHANGE, NULL, window_hook, c->pid, 0, WINEVENT_OUTOFCONTEXT);
    HWINEVENTHOOK state = SetWinEventHook(EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND, NULL, window_hook, c->pid, 0, WINEVENT_OUTOFCONTEXT);
    LARGE_INTEGER now, frequency; FILETIME wall;
    QueryPerformanceCounter(&now); QueryPerformanceFrequency(&frequency); GetSystemTimeAsFileTime(&wall);
    AcquireSRWLockExclusive(&c->lock);
    c->status.started_qpc = now.QuadPart; c->status.qpc_frequency = frequency.QuadPart;
    c->status.started_unix_ms = (int64_t)((((uint64_t)wall.dwHighDateTime << 32) | wall.dwLowDateTime) / 10000) - 11644473600000LL;
    c->status.attached = !!mouse + !!keyboard + !!windows + !!state; c->status.snapshot_valid = 1;
    ReleaseSRWLockExclusive(&c->lock);
    RcEvent baseline = {0};
    if (!mouse || !keyboard || !windows || !state) end(c, RC_START_FAILED);
    else if (!geometry(c, &baseline)) end(c, RC_TARGET_LOST);
    else { baseline.kind = RC_BASELINE; baseline.phase = RC_CONTROL_PHASE; append(c, &baseline); }
    SetEvent(c->ready); ULONGLONG expires = GetTickCount64() + c->duration_ms;
    for (;;) {
        ULONGLONG tick = GetTickCount64();
        if (tick >= expires) { end(c, RC_EXPIRED); break; }
        DWORD result = MsgWaitForMultipleObjects(1, &c->stop, FALSE, (DWORD)(expires - tick), QS_ALLINPUT);
        if (result == WAIT_OBJECT_0) break;
        if (result == WAIT_TIMEOUT) { end(c, RC_EXPIRED); break; }
        if (result != WAIT_OBJECT_0 + 1) { end(c, RC_START_FAILED); break; }
        MSG message;
        while (PeekMessageW(&message, NULL, 0, 0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
    }
    if (mouse) UnhookWindowsHookEx(mouse); if (keyboard) UnhookWindowsHookEx(keyboard);
    if (windows) UnhookWinEvent(windows); if (state) UnhookWinEvent(state);
    AcquireSRWLockExclusive(&c->lock); c->status.detached = c->status.attached; c->status.cleanup = 1; ReleaseSRWLockExclusive(&c->lock);
    current = NULL; return 0;
}
static void free_client(RcClient *c) {
    if (c->identity) {
        if (GetPropW(c->root, MAKEINTATOM(c->identity)) == (HANDLE)c) RemovePropW(c->root, MAKEINTATOM(c->identity));
        GlobalDeleteAtom(c->identity);
    }
    if (c->thread) CloseHandle(c->thread); if (c->ready) CloseHandle(c->ready); if (c->stop) CloseHandle(c->stop);
    if (c->events) HeapFree(GetProcessHeap(), 0, c->events); HeapFree(GetProcessHeap(), 0, c);
}
int rc_open(uintptr_t root, uint32_t capacity, uint32_t duration_ms, uint32_t timeout_ms, RcClient **output) {
    if (!output || !root || !capacity || capacity > RC_MAX_CAPACITY || !duration_ms || !timeout_ms) return RC_INVALID;
    *output = NULL;
    if (!IsWindow((HWND)root) || GetAncestor((HWND)root, GA_ROOT) != (HWND)root) return RC_TARGET;
    RcClient *c = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*c));
    if (!c) return RC_INSTALL_FAILED;
    c->root = (HWND)root; c->tid = GetWindowThreadProcessId(c->root, &c->pid); c->capacity = capacity; c->duration_ms = duration_ms;
    c->events = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(RcEvent) * capacity);
    c->ready = CreateEventW(NULL, TRUE, FALSE, NULL); c->stop = CreateEventW(NULL, TRUE, FALSE, NULL);
    wchar_t name[100]; wsprintfW(name, L"BKA.Recording.%lu.%p", GetCurrentProcessId(), c); c->identity = GlobalAddAtomW(name);
    if (!c->events || !c->ready || !c->stop || !c->identity || !SetPropW(c->root, MAKEINTATOM(c->identity), (HANDLE)c)) { free_client(c); return RC_INSTALL_FAILED; }
    c->thread = CreateThread(NULL, 0, observe, c, 0, NULL);
    if (!c->thread) { free_client(c); return RC_INSTALL_FAILED; }
    *output = c;
    if (WaitForSingleObject(c->ready, timeout_ms) != WAIT_OBJECT_0) { end(c, RC_START_FAILED); return RC_PENDING; }
    AcquireSRWLockShared(&c->lock); int result = c->status.reason == RC_RUNNING ? RC_OK : RC_INSTALL_FAILED; ReleaseSRWLockShared(&c->lock);
    return result;
}
int rc_read(RcClient *c, uint32_t ack, RcEvent *events, uint32_t limit, uint32_t *count, RcStatus *status) {
    if (!c || !events || !limit || !count || !status) return RC_INVALID;
    *count = 0; AcquireSRWLockExclusive(&c->lock); int result = RC_OK;
    if (ack < c->status.acknowledged || ack > c->delivered) result = RC_CURSOR;
    else {
        c->status.acknowledged = ack; uint32_t available = c->status.reserved - ack; *count = available < limit ? available : limit;
        for (uint32_t i = 0; i < *count; ++i) events[i] = c->events[(ack + i) % c->capacity];
        if (ack + *count > c->delivered) c->delivered = ack + *count;
        c->status.delivered = c->delivered;
    }
    *status = c->status; ReleaseSRWLockExclusive(&c->lock); return result;
}
int rc_stop(RcClient *c, uint32_t timeout_ms, RcStatus *status) {
    if (!c || !status) return RC_INVALID;
    end(c, RC_STOPPED); int result = WaitForSingleObject(c->thread, timeout_ms) == WAIT_OBJECT_0 ? RC_OK : RC_PENDING;
    AcquireSRWLockShared(&c->lock); *status = c->status; ReleaseSRWLockShared(&c->lock); return result;
}
int rc_close(RcClient *c, uint32_t timeout_ms, int discard, RcStatus *status) {
    int result = rc_stop(c, timeout_ms, status); if (result != RC_OK) return result;
    if (!discard && status->acknowledged != status->reserved) return RC_UNACKNOWLEDGED;
    free_client(c); return RC_OK;
}
