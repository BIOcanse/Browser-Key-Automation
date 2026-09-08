#include "wire.h"
#include <stdio.h>
#include <stdlib.h>

#define FIXTURE_ACTION (WM_APP + 90)
#define FIXTURE_COUNT (WM_APP + 91)
#define FIXTURE_READY (WM_APP + 92)
static HWND root_window, same_child, other_child, unrelated_window;
static HANDLE child_thread;
static HANDLE transient_thread;
static DWORD child_tid;
static volatile LONG input_count;
static DWORD WINAPI transient_main(void *unused);

static LRESULT CALLBACK fixture_proc(HWND hwnd, UINT message, WPARAM wp, LPARAM lp) {
    if (message == FIXTURE_READY) {
        printf("{\"kind\":\"ready\",\"pid\":%lu,\"root\":\"%llu\",\"sameChild\":\"%llu\",\"otherChild\":\"%llu\",\"unrelated\":\"%llu\"}\n",
            GetCurrentProcessId(), (unsigned long long)(uintptr_t)root_window, (unsigned long long)(uintptr_t)same_child,
            (unsigned long long)(uintptr_t)other_child, (unsigned long long)(uintptr_t)unrelated_window);
        fflush(stdout); return 1;
    }
    if (message == FIXTURE_COUNT) return InterlockedCompareExchange(&input_count, 0, 0);
    if (message == FIXTURE_ACTION) {
        if (wp == 1) return SetWindowPos(hwnd, NULL, 260, 180, 720, 540, SWP_NOACTIVATE | SWP_NOZORDER);
        if (wp == 2) return SetWindowPos(hwnd, NULL, 340, 220, 760, 560, SWP_NOACTIVATE | SWP_NOZORDER);
        if (wp == 3) { ShowWindow(hwnd, SW_SHOWMINNOACTIVE); return IsIconic(hwnd); }
        if (wp == 4) { ShowWindow(hwnd, SW_SHOWNOACTIVATE); return !IsIconic(hwnd); }
        if (wp == 5) { ShowWindow(hwnd, SW_HIDE); return !IsWindowVisible(hwnd); }
        if (wp == 6) {
            PostMessageW(hwnd, WM_MOUSEMOVE, 0, MAKELPARAM(31, 41));
            MSG queued;
            PeekMessageW(&queued, hwnd, WM_MOUSEMOVE, WM_MOUSEMOVE, PM_NOREMOVE);
            PeekMessageW(&queued, hwnd, WM_MOUSEMOVE, WM_MOUSEMOVE, PM_NOREMOVE);
            if (PeekMessageW(&queued, hwnd, WM_MOUSEMOVE, WM_MOUSEMOVE, PM_REMOVE)) DispatchMessageW(&queued);
            return 1;
        }
        if (wp == 7) return SetParent(other_child, unrelated_window) == root_window;
        if (wp == 8 && !transient_thread) { transient_thread = CreateThread(NULL, 0, transient_main, NULL, 0, NULL); return transient_thread != NULL; }
        if (wp == 9) return transient_thread && WaitForSingleObject(transient_thread, 0) == WAIT_OBJECT_0;
    }
    if ((message >= WM_MOUSEFIRST && message <= WM_MOUSELAST) || (message >= WM_KEYFIRST && message <= WM_KEYLAST)) {
        InterlockedIncrement(&input_count); return 0;
    }
    if (message == WM_CLOSE && hwnd == root_window) {
        PostThreadMessageW(child_tid, WM_QUIT, 0, 0);
        DestroyWindow(hwnd); PostQuitMessage(0); return 0;
    }
    if (message == WM_TIMER && hwnd == root_window) { PostQuitMessage(2); return 0; }
    return DefWindowProcW(hwnd, message, wp, lp);
}

static DWORD WINAPI transient_main(void *unused) {
    (void)unused;
    HWND child = CreateWindowExW(0, L"BkaRecordingProbe", L"transient-thread child", WS_CHILD, 30, 30, 100, 100,
        root_window, NULL, GetModuleHandleW(NULL), NULL);
    if (!child || !PostMessageW(child, WM_MOUSEMOVE, 0, MAKELPARAM(11, 13))) return 1;
    MSG message;
    if (GetMessageW(&message, child, WM_MOUSEMOVE, WM_MOUSEMOVE) > 0) DispatchMessageW(&message);
    DestroyWindow(child);
    return 0;
}

static DWORD WINAPI child_main(void *unused) {
    (void)unused;
    other_child = CreateWindowExW(0, L"BkaRecordingProbe", L"other-thread child", WS_CHILD, 230, 20, 200, 150,
        root_window, NULL, GetModuleHandleW(NULL), NULL);
    PostMessageW(root_window, FIXTURE_READY, 0, 0);
    MSG message;
    while (GetMessageW(&message, NULL, 0, 0) > 0) DispatchMessageW(&message);
    if (IsWindow(other_child)) DestroyWindow(other_child);
    return 0;
}

static int target(void) {
    WNDCLASSW cls = {.lpfnWndProc = fixture_proc, .hInstance = GetModuleHandleW(NULL), .lpszClassName = L"BkaRecordingProbe"};
    if (!RegisterClassW(&cls)) return 2;
    root_window = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, cls.lpszClassName, L"Recording route fixture",
        WS_OVERLAPPEDWINDOW, 100, 100, 640, 480, NULL, NULL, cls.hInstance, NULL);
    if (!root_window) return 3;
    same_child = CreateWindowExW(0, cls.lpszClassName, L"same-thread child", WS_CHILD, 20, 20, 200, 150,
        root_window, NULL, cls.hInstance, NULL);
    unrelated_window = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, cls.lpszClassName, L"Unrelated fixture",
        WS_OVERLAPPEDWINDOW, 900, 100, 640, 480, NULL, NULL, cls.hInstance, NULL);
    child_thread = CreateThread(NULL, 0, child_main, NULL, 0, &child_tid);
    if (!same_child || !unrelated_window || !child_thread) return 4;
    SetTimer(root_window, 1, 30000, NULL);
    MSG message;
    while (GetMessageW(&message, NULL, 0, 0) > 0) DispatchMessageW(&message);
    PostThreadMessageW(child_tid, WM_QUIT, 0, 0);
    WaitForSingleObject(child_thread, 2000); CloseHandle(child_thread);
    if (transient_thread) { WaitForSingleObject(transient_thread, 2000); CloseHandle(transient_thread); }
    return 0;
}

static int rr_send(HWND hwnd, UINT message, WPARAM wp, LPARAM lp, DWORD_PTR *result) {
    return SendMessageTimeoutW(hwnd, message, wp, lp, SMTO_BLOCK | SMTO_ABORTIFHUNG, 2000, result) != 0;
}
static int action(HWND hwnd, WPARAM code) { DWORD_PTR result = 0; return rr_send(hwnd, FIXTURE_ACTION, code, 0, &result) && result; }
static int post(HWND root, HWND hwnd, UINT message, WPARAM wp, LPARAM lp) {
    DWORD_PTR before = 0, current = 0;
    if (!rr_send(root, FIXTURE_COUNT, 0, 0, &before) || !PostMessageW(hwnd, message, wp, lp)) return 0;
    ULONGLONG deadline = GetTickCount64() + 2000;
    while (GetTickCount64() < deadline) {
        if (!rr_send(root, FIXTURE_COUNT, 0, 0, &current)) return 0;
        if (current == before + 1) return 1;
        Sleep(1);
    }
    return 0;
}

static void print_event(const RrEvent *event) {
    printf("{\"kind\":\"recorded\",\"sequence\":%u,\"eventKind\":%u,\"phase\":%u,\"message\":%u,\"tid\":%u,\"hwnd\":\"%llu\",\"qpc\":\"%lld\",\"messageTime\":%u,\"dpi\":%u,\"visible\":%u,\"iconic\":%u,\"window\":[%ld,%ld,%ld,%ld],\"clientScreen\":[%ld,%ld,%ld,%ld],\"point\":",
        event->sequence, event->kind, event->phase, event->message, event->tid, (unsigned long long)event->hwnd,
        (long long)event->qpc, event->message_time, event->dpi, event->visible, event->iconic,
        event->window.left, event->window.top, event->window.right, event->window.bottom,
        event->client_screen.left, event->client_screen.top, event->client_screen.right, event->client_screen.bottom);
    if (event->point_valid) printf("[%d,%d]", event->x, event->y); else printf("null");
    printf(",\"wparam\":\"%llu\",\"keyLparam\":\"%llu\",\"layout\":\"%llu\",\"position\":[%d,%d,%d,%d],\"positionFlags\":%u,\"source\":\"unknown\"}\n",
        (unsigned long long)event->wparam, (unsigned long long)event->key_lparam, (unsigned long long)event->keyboard_layout,
        event->position_x, event->position_y, event->position_width, event->position_height, event->position_flags);
}

static int controller(HWND root, HWND same, HWND other, HWND unrelated, int mode) {
    HWND before_foreground = GetForegroundWindow(); POINT before_pointer, after_pointer;
    GetCursorPos(&before_pointer);
    DWORD pid = 0, tid = GetWindowThreadProcessId(root, &pid), other_pid = 0;
    DWORD other_tid = GetWindowThreadProcessId(other, &other_pid);
    if (!pid || pid != other_pid || !tid || !other_tid || (mode != 2 && tid == other_tid) || GetAncestor(other, GA_ROOT) != root ||
        GetAncestor(same, GA_ROOT) != root || (mode != 2 && GetAncestor(unrelated, GA_ROOT) == root)) return 5;
    unsigned thread_count = tid == other_tid ? 1 : 2;
    UINT control = RegisterWindowMessageW(RR_CONTROL);
    uintptr_t token = ((uintptr_t)GetCurrentProcessId() << 32) | 1;
    wchar_t name[128], path[32768];
    swprintf(name, 128, L"Local\\BKA.RecordingProbe.%llu", (unsigned long long)token);
    HANDLE mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE, 0, sizeof(RrShared), name);
    if (!mapping || GetLastError() == ERROR_ALREADY_EXISTS) return 6;
    RrShared *s = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(*s));
    if (!s) { CloseHandle(mapping); return 7; }
    *s = (RrShared){.magic = RR_MAGIC, .bytes = sizeof(*s), .owner_pid = GetCurrentProcessId(), .target_pid = pid,
        .thread_count = thread_count, .thread_ids = {tid, other_tid}, .root = (uintptr_t)root, .token = token,
        .owner_created = rr_created(GetCurrentProcess()), .enabled = 1, .mouse_inside = -1};
    HMODULE library = NULL; HHOOK hooks[4] = {0}; ATOM atom = 0; int result = 0, cleanup = 1;
    HWND threads[2] = {root, other};
    DWORD_PTR ignored = 0;
    if (!s->owner_created || !SetPropW(root, RR_OWNER_TIME, (HANDLE)(uintptr_t)s->owner_created) ||
        !SetPropW(root, RR_OWNER, (HANDLE)token)) { result = 8; goto done; }
    DWORD length = GetModuleFileNameW(NULL, path, 32768);
    while (length && path[length - 1] != L'\\') --length;
    const wchar_t dll[] = L"recording-observer-probe.dll";
    if (!length || length + sizeof(dll) / sizeof(wchar_t) > 32768) { result = 9; goto done; }
    memcpy(path + length, dll, sizeof(dll));
    library = LoadLibraryExW(path, NULL, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    HOOKPROC window_hook = library ? (HOOKPROC)GetProcAddress(library, "RrWindowHook") : NULL;
    HOOKPROC queue_hook = library ? (HOOKPROC)GetProcAddress(library, "RrQueueHook") : NULL;
    atom = GlobalAddAtomW(name);
    if (!window_hook || !queue_hook || !atom) { result = 10; goto done; }
    for (unsigned i = 0; i < thread_count; ++i) {
        hooks[i * 2] = SetWindowsHookExW(WH_CALLWNDPROC, window_hook, library, s->thread_ids[i]);
        hooks[i * 2 + 1] = SetWindowsHookExW(WH_GETMESSAGE, queue_hook, library, s->thread_ids[i]);
        if (!hooks[i * 2] || !hooks[i * 2 + 1] || !rr_send(threads[i], control, atom, RR_ATTACH, &ignored)) { result = 11; goto done; }
    }
    if (s->attached != (1 << thread_count) - 1) { result = 12; goto done; }
    if (mode == 2) {
        RECT bounds; GetClientRect(same, &bounds);
        printf("{\"kind\":\"observerReady\",\"root\":\"%llu\",\"content\":\"%llu\",\"threads\":%u,\"width\":%ld,\"height\":%ld}\n",
            (unsigned long long)(uintptr_t)root, (unsigned long long)(uintptr_t)same, thread_count, bounds.right, bounds.bottom); fflush(stdout);
        char line[128];
        while (fgets(line, sizeof(line), stdin)) {
            int x, y; unsigned character; int accepted = 0;
            if (strcmp(line, "stop\n") == 0 || strcmp(line, "stop\r\n") == 0) break;
            if (sscanf(line, "move %d %d", &x, &y) == 2 && x >= -32768 && x <= 32767 && y >= -32768 && y <= 32767)
                accepted = PostMessageW(same, WM_MOUSEMOVE, 0, MAKELPARAM((SHORT)x, (SHORT)y)) != 0;
            else if (sscanf(line, "char %u", &character) == 1 && character > 0 && character <= 0xffff)
                accepted = PostMessageW(same, WM_CHAR, character, 1) != 0;
            else if (strcmp(line, "measure\n") == 0 || strcmp(line, "measure\r\n") == 0) accepted = 1;
            GetClientRect(same, &bounds);
            printf("{\"kind\":\"operation\",\"accepted\":%s,\"width\":%ld,\"height\":%ld,\"observedThrough\":%ld,\"inside\":%ld}\n",
                accepted ? "true" : "false", bounds.right, bounds.bottom, s->next, InterlockedCompareExchange(&s->mouse_inside, 0, 0)); fflush(stdout);
        }
        goto done;
    }
#define REQUIRE(expression, failure) do { if (!(expression)) { result = failure; goto done; } } while (0)
    if (mode == 1) {
        for (unsigned i = 0; i < RR_CAPACITY + 5; ++i) REQUIRE(post(root, same, WM_MOUSEMOVE, 0, MAKELPARAM(10, 15)), 13);
    } else {
        REQUIRE(post(root, same, WM_MOUSEMOVE, 0, MAKELPARAM(10, 15)), 14);
        REQUIRE(post(root, same, WM_LBUTTONDOWN, MK_LBUTTON, MAKELPARAM(10, 15)), 15);
        REQUIRE(post(root, same, WM_MOUSEMOVE, MK_LBUTTON, MAKELPARAM(-2000, -2000)), 16);
        REQUIRE(post(root, same, WM_MOUSEMOVE, MK_LBUTTON, MAKELPARAM(-2200, -2300)), 17);
        REQUIRE(post(root, same, WM_LBUTTONUP, 0, MAKELPARAM(-2200, -2300)), 18);
        REQUIRE(action(root, 1), 19);
        REQUIRE(action(root, 2), 20);
        REQUIRE(action(root, 3), 21);
        REQUIRE(action(root, 4), 22);
        REQUIRE(action(root, 5), 23);
        REQUIRE(post(root, other, WM_MOUSEMOVE, 0, MAKELPARAM(13, 17)), 24);
        REQUIRE(post(root, other, WM_KEYDOWN, 'A', ((LPARAM)30 << 16) | 1), 25);
        REQUIRE(post(root, other, WM_KEYDOWN, 'A', ((LPARAM)1 << 30) | ((LPARAM)30 << 16) | 3), 26);
        REQUIRE(post(root, other, WM_KEYUP, 'A', ((LPARAM)3 << 30) | ((LPARAM)30 << 16) | 1), 27);
        REQUIRE(post(root, other, WM_CHAR, 0x4e2d, 1), 28);
        REQUIRE(post(root, unrelated, WM_MOUSEMOVE, 0, MAKELPARAM(33, 45)), 29);
        REQUIRE(action(root, 6), 30);
    }
#undef REQUIRE
done:
    InterlockedExchange(&s->enabled, 0);
    for (unsigned i = 0; i < thread_count; ++i) if (s->attached & (1 << i)) {
        if (!rr_send(threads[i], control, token, RR_DETACH, &ignored)) cleanup = 0;
    }
    for (unsigned i = 0; i < 4; ++i) if (hooks[i] && !UnhookWindowsHookEx(hooks[i])) cleanup = 0;
    if (s->detached != s->attached || s->callbacks != 0) cleanup = 0;
    LONG count = s->next < RR_CAPACITY ? s->next : RR_CAPACITY;
    if (cleanup) {
        for (LONG i = 0; i < count; ++i) {
            if (!s->events[i].committed) { result = 31; break; }
            print_event(&s->events[i]);
        }
    }
    int input_after_stop = mode == 2 ? cleanup : cleanup && post(root, same, WM_MOUSEMOVE, 0, MAKELPARAM(50, 60));
    GetCursorPos(&after_pointer);
    printf("{\"kind\":\"receipt\",\"result\":%d,\"cleanup\":%s,\"count\":%ld,\"lost\":%ld,\"attached\":%ld,\"detached\":%ld,\"inputAfterStop\":%s,\"cursorUnchanged\":%s,\"foregroundUnchanged\":%s,\"sampling\":\"window-message-and-queue-remove\",\"stimulus\":\"synthetic-posted-messages\"}\n",
        result, cleanup ? "true" : "false", count, s->lost, s->attached, s->detached,
        mode == 2 ? "null" : input_after_stop ? "true" : "false", before_pointer.x == after_pointer.x && before_pointer.y == after_pointer.y ? "true" : "false",
        before_foreground == GetForegroundWindow() ? "true" : "false");
    fflush(stdout);
    if (cleanup) {
        if ((uintptr_t)GetPropW(root, RR_OWNER) == token) { RemovePropW(root, RR_OWNER); RemovePropW(root, RR_OWNER_TIME); }
        if (atom) GlobalDeleteAtom(atom);
        if (library) FreeLibrary(library);
        UnmapViewOfFile(s); CloseHandle(mapping);
    }
    /* Unknown cleanup is never retried; process teardown leaves callback-owned
       mapping handles alive until that target observes owner death. */
    return result ? result : cleanup && input_after_stop ? 0 : 32;
}

typedef struct BrowserMatch { DWORD pid; const wchar_t *marker; HWND root, content; unsigned roots, contents; double width, height; } BrowserMatch;
static BOOL CALLBACK browser_root(HWND hwnd, LPARAM value) {
    BrowserMatch *match = (BrowserMatch *)value; DWORD pid = 0; wchar_t title[512], cls[128];
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == match->pid && IsWindowVisible(hwnd) && GetClassNameW(hwnd, cls, 128) && !wcscmp(cls, L"Chrome_WidgetWin_1") &&
        GetWindowTextW(hwnd, title, 512) && wcsstr(title, match->marker)) { match->root = hwnd; ++match->roots; }
    return TRUE;
}
static BOOL CALLBACK browser_content(HWND hwnd, LPARAM value) {
    BrowserMatch *match = (BrowserMatch *)value; DWORD pid = 0; wchar_t cls[128]; RECT bounds;
    DWORD tid = GetWindowThreadProcessId(hwnd, &pid);
    if (pid != match->pid) {
        GetClassNameW(hwnd, cls, 128);
        printf("{\"kind\":\"foreignChild\",\"pid\":%lu,\"tid\":%lu,\"class\":\"%ls\"}\n", pid, tid, cls); fflush(stdout);
    }
    if (pid != match->pid || GetAncestor(hwnd, GA_ROOT) != match->root || !IsWindowVisible(hwnd) ||
        !GetClassNameW(hwnd, cls, 128) || wcscmp(cls, L"Chrome_RenderWidgetHostHWND") || !GetClientRect(hwnd, &bounds)) return TRUE;
    double difference = bounds.right * match->height - bounds.bottom * match->width;
    if (bounds.right > 0 && bounds.bottom > 0 && difference >= -(match->width + match->height) && difference <= match->width + match->height) {
        match->content = hwnd; ++match->contents;
    }
    return TRUE;
}

static int browser_target(int argc, char **argv) {
    if (argc != 6) return 2;
    wchar_t marker[128];
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, argv[3], -1, marker, 128)) return 40;
    BrowserMatch match = {.pid = (DWORD)strtoul(argv[2], NULL, 10), .marker = marker, .width = atof(argv[4]), .height = atof(argv[5])};
    if (!match.pid || match.width <= 0 || match.height <= 0) return 41;
    ULONGLONG deadline = GetTickCount64() + 2000;
    do {
        match.roots = 0; match.contents = 0;
        EnumWindows(browser_root, (LPARAM)&match);
        if (match.roots == 1) EnumChildWindows(match.root, browser_content, (LPARAM)&match);
        if ((match.roots == 1 && match.contents == 1) || match.roots > 1 || match.contents > 1) break;
        Sleep(10);
    } while (GetTickCount64() < deadline);
    if (match.roots != 1) { fprintf(stderr, "root matches: %u\n", match.roots); return 42; }
    if (match.contents != 1) { fprintf(stderr, "content matches: %u for viewport %.1fx%.1f\n", match.contents, match.width, match.height); return 43; }
    return controller(match.root, match.content, match.content, NULL, 2);
}

int main(int argc, char **argv) {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    if (argc == 2 && strcmp(argv[1], "target") == 0) return target();
    if (argc >= 2 && strcmp(argv[1], "browser") == 0) return browser_target(argc, argv);
    if (argc < 3) return 2;
    HWND root = (HWND)(uintptr_t)strtoull(argv[2], NULL, 10);
    if (strcmp(argv[1], "close") == 0) { PostMessageW(root, WM_CLOSE, 0, 0); return 0; }
    if (argc != 6) return 2;
    return controller(root, (HWND)(uintptr_t)strtoull(argv[3], NULL, 10),
        (HWND)(uintptr_t)strtoull(argv[4], NULL, 10), (HWND)(uintptr_t)strtoull(argv[5], NULL, 10), strcmp(argv[1], "overflow") == 0);
}
