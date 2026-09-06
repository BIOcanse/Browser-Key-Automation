// Explicit diagnostic build only. The observe variant keeps delivery unchanged;
// queue/projection are disposable one-target mechanical counterfactuals.
#define COBJMACROS
#define _WIN32_WINNT 0x0601
#include <windows.h>
#include <commctrl.h>
static LRESULT WINAPI diagnostic_subclass(HWND, UINT, WPARAM, LPARAM);
#define DefSubclassProc diagnostic_subclass
#define MH_EnableHook diagnostic_enable_hooks
#define MH_CreateHookApi diagnostic_create_api
#include "../../../../app/src/virtual_mouse/windows/hook.c"
#undef MH_EnableHook
#undef MH_CreateHookApi
#undef DefSubclassProc
#include <ole2.h>
#include <stdio.h>

MH_STATUS WINAPI MH_EnableHook(LPVOID);
MH_STATUS WINAPI MH_CreateHookApi(LPCWSTR, LPCSTR, LPVOID, LPVOID *);
static HRESULT (WINAPI *original_drag)(IDataObject *, IDropSource *, DWORD, DWORD *);
static BOOL (WINAPI *original_peek)(LPMSG, HWND, UINT, UINT, UINT);
static HRESULT (STDMETHODCALLTYPE *original_continue)(IDropSource *, BOOL, DWORD);
static HRESULT (STDMETHODCALLTYPE *original_feedback)(IDropSource *, DWORD);
static _Thread_local unsigned in_drag, records, empty_peeks, other_peeks;
static _Thread_local ULONGLONG drag_started;
static _Thread_local unsigned tail_queries;
static int diagnostic_installed;
static _Thread_local HWND observed_target;
static _Thread_local int multiple_targets;
static _Thread_local WPARAM observed_up_flags;
static _Thread_local LPARAM observed_up_point;
static _Thread_local int observed_up;
static _Thread_local unsigned input_records;
static _Thread_local VmShared observed_snapshot;
static _Thread_local VmTarget projection;
static _Thread_local HANDLE projection_owner;

#ifdef BKA_VM_DELAYED_RELEASE_PROBE
typedef struct DelayedRelease { HWND hwnd; WPARAM flags; LPARAM point; uintptr_t token; } DelayedRelease;
static void CALLBACK release_later(LPVOID context, BOOLEAN fired) {
    (void)fired;
    const DelayedRelease *release = context;
    if (IsWindow(release->hwnd) && (uintptr_t)GetPropW(release->hwnd, VM_OWNER_PROPERTY) == release->token) {
        PostMessageW(release->hwnd, WM_MOUSEMOVE, release->flags | MK_LBUTTON, release->point);
        PostMessageW(release->hwnd, WM_LBUTTONUP, release->flags, release->point);
    }
}
#endif

#ifdef BKA_VM_QUEUE_PROBE
typedef struct QueueProbe {
    int queued;
#ifdef BKA_VM_DELAYED_RELEASE_PROBE
    HANDLE timer;
    DelayedRelease release;
#endif
} QueueProbe;
static _Thread_local QueueProbe *queue_probe;
#endif
static void try_queue_probe(void);

// Restrict this experiment's query override to calls made directly by OLE.
// It still assumes the one-target fixture; it is not production provenance.
static int ole_caller(void *address) {
    HMODULE module = NULL;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, (LPCWSTR)address, &module);
    return module && (module == GetModuleHandleW(L"ole32.dll") || module == GetModuleHandleW(L"combase.dll"));
}
static int projected_call(void *address) {
#ifdef BKA_VM_PROJECTION_PROBE
    return in_drag && !multiple_targets && observed_up && active(&projection) && ole_caller(address);
#else
    (void)address; return 0;
#endif
}

static LRESULT WINAPI diagnostic_subclass(HWND hwnd, UINT message, WPARAM wp, LPARAM lp) {
    int input = scope && active(scope) && message >= WM_MOUSEFIRST && message <= WM_MOUSELAST;
    if (input) {
        if (observed_target && observed_target != hwnd) multiple_targets = 1;
        observed_target = hwnd;
        if (message == WM_LBUTTONUP) {
            observed_up = 1; observed_up_flags = wp; observed_up_point = lp;
            observed_snapshot = *scope->shared;
            if (projection_owner) CloseHandle(projection_owner);
            projection_owner = NULL;
            DuplicateHandle(GetCurrentProcess(), scope->owner, GetCurrentProcess(), &projection_owner, 0, FALSE, DUPLICATE_SAME_ACCESS);
            projection = (VmTarget){ .hwnd = hwnd, .shared = &observed_snapshot, .owner = projection_owner };
        }
        if (input_records++ < 32) {
            fprintf(stderr, "[bka-ole] {\"kind\":\"input\",\"tick\":%llu,\"target\":%llu,\"message\":%u,\"buttons\":%u}\n",
                (unsigned long long)GetTickCount64(), (unsigned long long)(uintptr_t)hwnd, message, scope->shared->buttons); fflush(stderr);
        }
    }
    LRESULT result = DefSubclassProc(hwnd, message, wp, lp);
    if (input && message == WM_LBUTTONUP) try_queue_probe();
    return result;
}

static int record_allowed(void) {
    return in_drag && records++ < 256 && GetTickCount64() - drag_started <= 2000;
}
static void query(const char *kind, long long value, long long second) {
    if (!record_allowed()) return;
    fprintf(stderr, "[bka-ole] {\"kind\":\"%s\",\"ms\":%llu,\"tid\":%lu,\"scope\":%llu,\"value\":%lld,\"second\":%lld}\n",
        kind, (unsigned long long)(GetTickCount64() - drag_started), GetCurrentThreadId(),
        (unsigned long long)(uintptr_t)(scope ? scope->hwnd : NULL), value, second);
    fflush(stderr);
}
static void try_queue_probe(void) {
#ifdef BKA_VM_QUEUE_PROBE
    // One-target counterfactual only. UP may precede or follow OLE entry;
    // neither order establishes a production drag owner or permits replay.
    if (!queue_probe || queue_probe->queued || !in_drag || !observed_up || multiple_targets || !active(&projection)) return;
    queue_probe->queued = 1;
    WPARAM move_flags = observed_up_flags;
#ifdef BKA_VM_PROJECTION_PROBE
    move_flags |= MK_LBUTTON;
#endif
    BOOL moved = PostMessageW(observed_target, WM_MOUSEMOVE, move_flags, observed_up_point);
    BOOL released;
#ifdef BKA_VM_DELAYED_RELEASE_PROBE
    queue_probe->release = (DelayedRelease){observed_target, observed_up_flags, observed_up_point, observed_snapshot.token};
    released = CreateTimerQueueTimer(&queue_probe->timer, NULL, release_later, &queue_probe->release, 100, 0, WT_EXECUTEONLYONCE);
#else
    released = PostMessageW(observed_target, WM_LBUTTONUP, observed_up_flags, observed_up_point);
#endif
    query("queue-probe", moved, released);
#endif
}
static void caller(const char *kind, void *address) {
    if (!record_allowed()) return;
    HMODULE module = NULL; char name[MAX_PATH] = {0};
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, (LPCWSTR)address, &module);
    if (module) GetModuleFileNameA(module, name, sizeof(name));
    char *base = strrchr(name, '\\');
    fprintf(stderr, "[bka-ole] {\"kind\":\"%s-caller\",\"module\":\"%s\",\"rva\":%llu,\"projected\":%d}\n",
        kind, base ? base + 1 : name, module ? (unsigned long long)((uintptr_t)address - (uintptr_t)module) : 0, projected_call(address));
    fflush(stderr);
}
static void stack_sample(const char *kind, const POINT *point) {
    void *frames[16]; USHORT count = CaptureStackBackTrace(1, 16, frames, NULL);
    fprintf(stderr, "[bka-ole] {\"kind\":\"%s-stack\",\"inDrag\":%u,\"ms\":%llu,\"x\":%ld,\"y\":%ld,\"frames\":[",
        kind, in_drag, (unsigned long long)(GetTickCount64() - drag_started), point ? point->x : 0, point ? point->y : 0);
    for (USHORT i = 0; i < count; ++i) {
        HMODULE module = NULL; char name[MAX_PATH] = {0}; DWORD64 image_base = 0;
        GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, (LPCWSTR)frames[i], &module);
        if (module) GetModuleFileNameA(module, name, sizeof(name));
        char *base = strrchr(name, '\\');
        PRUNTIME_FUNCTION function = RtlLookupFunctionEntry((DWORD64)(uintptr_t)frames[i], &image_base, NULL);
        fprintf(stderr, "%s{\"module\":\"%s\",\"rva\":%llu,\"functionStart\":%lu}", i ? "," : "",
            base ? base + 1 : name, module ? (unsigned long long)((uintptr_t)frames[i] - (uintptr_t)module) : 0,
            function ? function->BeginAddress : 0);
    }
    fprintf(stderr, "]}\n"); fflush(stderr);
}
static BOOL WINAPI diagnostic_cursor(LPPOINT p) {
    caller("cursor", __builtin_return_address(0));
    VmTarget *previous = scope;
    if (projected_call(__builtin_return_address(0))) scope = &projection;
    BOOL result = hooked_cursor(p); query("cursor", result && p ? p->x : 0, result && p ? p->y : 0);
    if (drag_started && GetTickCount64() - drag_started <= 2000 && tail_queries++ < 8) stack_sample("cursor", result ? p : NULL);
    scope = previous; return result;
}
static SHORT WINAPI diagnostic_key(int key) {
    VmTarget *previous = scope; if (projected_call(__builtin_return_address(0))) scope = &projection;
    SHORT result = hooked_key(key); query("key", key, result); scope = previous; return result;
}
static SHORT WINAPI diagnostic_async_key(int key) {
    VmTarget *previous = scope; if (projected_call(__builtin_return_address(0))) scope = &projection;
    SHORT result = hooked_async_key(key); query("async-key", key, result); scope = previous; return result;
}
static BOOL WINAPI diagnostic_keys(PBYTE keys) {
    VmTarget *previous = scope; if (projected_call(__builtin_return_address(0))) scope = &projection;
    BOOL result = hooked_keyboard_state(keys); query("keys", result && keys ? keys[VK_LBUTTON] : -1, result && keys ? keys[VK_RBUTTON] : -1);
    scope = previous; return result;
}
static HWND WINAPI diagnostic_window(POINT point) {
    caller("hit", __builtin_return_address(0));
    query("hit-point", point.x, point.y);
    HWND result;
    POINT cursor = {observed_snapshot.x, observed_snapshot.y};
    if (projected_call(__builtin_return_address(0)) && ClientToScreen(observed_target, &cursor) && point.x == cursor.x && point.y == cursor.y)
        result = GetAncestor(observed_target, GA_ROOT);
    else result = hooked_window_from_point(point);
    query("hit", (long long)(uintptr_t)result, 0); return result;
}
static HWND WINAPI diagnostic_capture(void) { HWND result = hooked_get_capture(); query("capture", (long long)(uintptr_t)result, 0); return result; }
static BOOL WINAPI diagnostic_peek(LPMSG message, HWND hwnd, UINT minimum, UINT maximum, UINT flags) {
    BOOL result = original_peek(message, hwnd, minimum, maximum, flags);
#ifdef BKA_VM_PROJECTION_PROBE
    if (in_drag && result && (flags & PM_REMOVE) && message->hwnd == observed_target && message->lParam == observed_up_point &&
        (message->message == WM_MOUSEMOVE || message->message == WM_LBUTTONUP)) {
        observed_snapshot.buttons = (message->wParam & MK_LBUTTON) ? 1 : 0;
        POINT point = {observed_snapshot.x, observed_snapshot.y};
        if (ClientToScreen(observed_target, &point)) {
            query("queue-original-point", message->pt.x, message->pt.y);
            message->pt = point;
        }
    }
#endif
    int mouse = result && message->message >= WM_MOUSEFIRST && message->message <= WM_MOUSELAST;
    if (in_drag && (mouse || (result ? other_peeks++ < 16 : empty_peeks++ < 16)) && record_allowed()) {
        fprintf(stderr, "[bka-ole] {\"kind\":\"peek\",\"ms\":%llu,\"hwnd\":%llu,\"min\":%u,\"max\":%u,\"flags\":%u,\"result\":%d,\"message\":%u,\"target\":%llu,\"wp\":%llu,\"lp\":%lld,\"x\":%ld,\"y\":%ld}\n",
            (unsigned long long)(GetTickCount64() - drag_started), (unsigned long long)(uintptr_t)hwnd,
            minimum, maximum, flags, result, result ? message->message : 0,
            result ? (unsigned long long)(uintptr_t)message->hwnd : 0, result ? (unsigned long long)message->wParam : 0,
            result ? (long long)message->lParam : 0, result ? message->pt.x : 0, result ? message->pt.y : 0); fflush(stderr);
    }
    return result;
}
static HRESULT STDMETHODCALLTYPE diagnostic_continue(IDropSource *source, BOOL escape, DWORD keys) {
    HRESULT result = original_continue(source, escape, keys);
    query("continue", keys, result); return result;
}
static HRESULT STDMETHODCALLTYPE diagnostic_feedback(IDropSource *source, DWORD effect) {
    HRESULT result = original_feedback(source, effect);
    query("feedback", effect, result); return result;
}
static HRESULT WINAPI diagnostic_drag(IDataObject *data, IDropSource *source, DWORD effects, DWORD *effect) {
    ++in_drag; records = empty_peeks = other_peeks = tail_queries = 0; drag_started = GetTickCount64();
    stack_sample("entry", NULL);
    query("enter", effects, (long long)(uintptr_t)real_get_capture());
    query("enter-tick", drag_started, observed_up);
    if (!original_continue) {
        LPVOID address = (LPVOID)source->lpVtbl->QueryContinueDrag;
        MH_STATUS result = MH_CreateHook(address, (LPVOID)diagnostic_continue, (LPVOID *)&original_continue);
        query("continue-hook", result, result == MH_OK ? MH_EnableHook(address) : -1);
    }
    if (!original_feedback) {
        LPVOID address = (LPVOID)source->lpVtbl->GiveFeedback;
        MH_STATUS result = MH_CreateHook(address, (LPVOID)diagnostic_feedback, (LPVOID *)&original_feedback);
        query("feedback-hook", result, result == MH_OK ? MH_EnableHook(address) : -1);
    }
    IOleWindow *window = NULL; HWND hwnd = NULL;
    HRESULT source_window = IDropSource_QueryInterface(source, &IID_IOleWindow, (void **)&window);
    if (SUCCEEDED(source_window)) { IOleWindow_GetWindow(window, &hwnd); IOleWindow_Release(window); }
    query("source-window", source_window, (long long)(uintptr_t)hwnd);
#ifdef BKA_VM_QUEUE_PROBE
    QueueProbe attempt = {0}, *previous_probe = queue_probe;
    queue_probe = &attempt;
    try_queue_probe();
#endif
    HRESULT result = original_drag(data, source, effects, effect);
    query("leave", result, effect ? *effect : 0);
#ifdef BKA_VM_DELAYED_RELEASE_PROBE
    if (attempt.timer) DeleteTimerQueueTimer(NULL, attempt.timer, INVALID_HANDLE_VALUE);
#endif
#ifdef BKA_VM_QUEUE_PROBE
    queue_probe = previous_probe;
#endif
    if (projection_owner) { CloseHandle(projection_owner); projection_owner = NULL; projection.owner = NULL; }
    --in_drag; return result;
}
MH_STATUS WINAPI diagnostic_create_api(LPCWSTR module, LPCSTR name, LPVOID replacement, LPVOID *original) {
    if (!strcmp(name, "GetCursorPos")) replacement = (LPVOID)diagnostic_cursor;
    if (!strcmp(name, "WindowFromPoint")) replacement = (LPVOID)diagnostic_window;
    if (!strcmp(name, "GetKeyState")) replacement = (LPVOID)diagnostic_key;
    if (!strcmp(name, "GetAsyncKeyState")) replacement = (LPVOID)diagnostic_async_key;
    if (!strcmp(name, "GetKeyboardState")) replacement = (LPVOID)diagnostic_keys;
    if (!strcmp(name, "GetCapture")) replacement = (LPVOID)diagnostic_capture;
    return MH_CreateHookApi(module, name, replacement, original);
}
MH_STATUS WINAPI diagnostic_enable_hooks(LPVOID target) {
    if (!diagnostic_installed) {
        MH_STATUS drag = MH_CreateHookApi(L"ole32.dll", "DoDragDrop", (LPVOID)diagnostic_drag, (LPVOID *)&original_drag);
        MH_STATUS peek = MH_CreateHookApi(L"user32.dll", "PeekMessageW", (LPVOID)diagnostic_peek, (LPVOID *)&original_peek);
        fprintf(stderr, "[bka-ole] {\"kind\":\"installed\",\"drag\":%d,\"peek\":%d}\n", drag, peek); fflush(stderr);
        if (drag != MH_OK || peek != MH_OK) return MH_ERROR_NOT_CREATED;
        diagnostic_installed = 1;
    }
    return MH_EnableHook(target);
}
