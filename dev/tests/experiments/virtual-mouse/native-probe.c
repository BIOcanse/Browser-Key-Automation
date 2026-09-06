#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include "wire.h"
static HWND nested_window;
static HANDLE observe_request, observe_done;
static volatile LONG observe_stop;
static int observe_window_pos;
static UINT observed_window_pos_flags;
static int observe_direct_other;

static void activation_passthrough(const char *kind, HWND hwnd) {
    // The invalid foreground target cannot activate any real window. All
    // positioning targets are hidden and never use SWP_SHOWWINDOW.
    SetLastError(0); BOOL foreground = SetForegroundWindow(NULL); DWORD error = GetLastError();
    observe_window_pos = 1; observed_window_pos_flags = 0;
    SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
    observe_window_pos = 0;
    printf("{\"kind\":\"%s\",\"foreground\":%d,\"error\":%lu,\"flags\":%u}\n", kind, foreground, error, observed_window_pos_flags); fflush(stdout);
}

static DWORD WINAPI observe_other_thread(LPVOID unused) {
    (void)unused;
    while (WaitForSingleObject(observe_request, 30000) == WAIT_OBJECT_0) {
        if (InterlockedCompareExchange(&observe_stop, 0, 0)) break;
        BYTE keys[256] = {0}; GetKeyboardState(keys);
        printf("{\"kind\":\"thread-isolation\",\"keyF24\":%d,\"arrayF24\":%u}\n",
               (GetKeyState(VK_F24) & 0x8000) != 0, keys[VK_F24]);
        fflush(stdout);
        SetEvent(observe_done);
    }
    return 0;
}

static LONG WINAPI crash(EXCEPTION_POINTERS *exception) {
    HMODULE module = NULL;
    wchar_t path[1024] = {0};
    void *address = exception->ExceptionRecord->ExceptionAddress;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                      (LPCWSTR)address, &module);
    if (module) GetModuleFileNameW(module, path, 1024);
    fprintf(stderr, "native probe exception=%08lx address=%p module=%ls offset=%llu\n",
            exception->ExceptionRecord->ExceptionCode, address, path,
            (unsigned long long)((uintptr_t)address - (uintptr_t)module));
    fflush(stderr);
    return EXCEPTION_EXECUTE_HANDLER;
}

static LRESULT CALLBACK probe_proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
    if (message == WM_WINDOWPOSCHANGING && observe_window_pos) {
        observed_window_pos_flags = ((WINDOWPOS *)lparam)->flags;
        if (observe_direct_other && hwnd == nested_window) {
            SetLastError(0); BOOL foreground = SetForegroundWindow(NULL); DWORD error = GetLastError();
            printf("{\"kind\":\"direct-other-positioning\",\"keyF24\":%d,\"foreground\":%d,\"error\":%lu}\n",
                (GetKeyState(VK_F24) & 0x8000) != 0, foreground, error); fflush(stdout);
        }
    }
    if (message == WM_APP + 3) {
        BYTE keys[256] = {0}; GetKeyboardState(keys);
        int outside_f24 = (GetKeyState(VK_F24) & 0x8000) != 0;
        BYTE changed[256]; memcpy(changed, keys, sizeof(changed)); changed[VK_F23] ^= 0x80;
        int set_ok = SetKeyboardState(changed);
        int outside_f23 = (GetKeyState(VK_F23) & 0x8000) != 0;
        SetKeyboardState(keys);
        printf("{\"kind\":\"keyboard-restore-isolation\",\"keyF24\":%d,\"arrayF24\":%u,\"outsideSetter\":%s}\n",
               outside_f24, keys[VK_F24], set_ok && outside_f23 == ((changed[VK_F23] & 0x80) != 0) ? "true" : "false");
        fflush(stdout);
        return 0;
    }
    if (message == WM_APP + 2) {
        LPARAM previous = SetMessageExtraInfo((LPARAM)wparam);
        SendMessageW(hwnd, WM_KEYDOWN, 'Z', 1);
        SetMessageExtraInfo(previous);
        return 0;
    }
    if (message >= WM_KEYFIRST && message <= WM_KEYLAST) {
        if (message == WM_KEYDOWN && wparam == 'Z') {
            activation_passthrough("real-key-positioning", hwnd);
        }
        if (message == WM_KEYDOWN && wparam == 'A') {
            SetEvent(observe_request);
            if (WaitForSingleObject(observe_done, 3000) != WAIT_OBJECT_0) ExitProcess(22);
        }
        BYTE keys[256] = {0}; GetKeyboardState(keys);
        POINT point = {0}; GetCursorPos(&point); ScreenToClient(hwnd, &point);
        printf("{\"kind\":\"key\",\"hwnd\":\"%llu\",\"message\":%u,\"vk\":%llu,\"shift\":%d,\"asyncShift\":%d,\"arrayShift\":%u,\"arrayCaps\":%u,\"arrayA\":%u,\"pointerX\":%ld,\"pointerY\":%ld,\"left\":%d}\n",
               (unsigned long long)(uintptr_t)hwnd, message, (unsigned long long)wparam,
               (GetKeyState(VK_SHIFT) & 0x8000) != 0, (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0,
               keys[VK_SHIFT], keys[VK_CAPITAL], keys['A'], point.x, point.y, (GetKeyState(VK_LBUTTON) & 0x8000) != 0);
        fflush(stdout);
        // Chromium's PlatformKeyMap saves and restores this table while it
        // initializes a layout. A virtual snapshot must not leak into the real
        // thread's table when the callback exits.
        if (message == WM_KEYDOWN && wparam == 'A') {
            SetLastError(0);
            BOOL accepted = SetKeyboardState(keys);
            printf("{\"kind\":\"keyboard-restore-result\",\"accepted\":%d,\"error\":%lu}\n", accepted, GetLastError());
            fflush(stdout);
        }
        return 0;
    }
    if ((message >= WM_MOUSEFIRST && message <= WM_MOUSELAST) || message == WM_APP + 1) {
        if (message == WM_APP + 1 && wparam == 77) {
            activation_passthrough("nested-positioning", hwnd);
        }
        POINT p = {0}, client = {0};
        GetCursorPos(&p); client = p; ScreenToClient(hwnd, &client);
        POINT away = {p.x + 1, p.y + 1};
        printf("{\"kind\":\"event\",\"hwnd\":\"%llu\",\"message\":%u,\"x\":%d,\"y\":%d,"
               "\"queryX\":%ld,\"queryY\":%ld,\"screenX\":%ld,\"screenY\":%ld,"
               "\"left\":%d,\"asyncLeft\":%d,\"hit\":\"%llu\",\"awayHit\":\"%llu\",\"flags\":%llu}\n",
               (unsigned long long)(uintptr_t)hwnd, message, (SHORT)LOWORD(lparam), (SHORT)HIWORD(lparam),
               client.x, client.y, p.x, p.y, (GetKeyState(VK_LBUTTON) & 0x8000) != 0,
               (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0,
               (unsigned long long)(uintptr_t)WindowFromPoint(p),
               (unsigned long long)(uintptr_t)WindowFromPoint(away), (unsigned long long)wparam);
        fflush(stdout);
        if (message == WM_LBUTTONDOWN) {
            observed_window_pos_flags = 0; observe_window_pos = 1;
            SetLastError(0); BOOL foreground = SetForegroundWindow(hwnd); DWORD foreground_error = GetLastError();
            BOOL positioned = SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            observe_window_pos = 0;
            printf("{\"kind\":\"virtual-activation\",\"foreground\":%d,\"error\":%lu,\"positioned\":%d,\"flags\":%u}\n", foreground, foreground_error, positioned, observed_window_pos_flags);
            fflush(stdout);
            if (nested_window && hwnd != nested_window) {
                observe_direct_other = observe_window_pos = 1;
                SetWindowPos(nested_window, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
                observe_direct_other = observe_window_pos = 0;
                printf("{\"kind\":\"after-direct-positioning\",\"keyF24\":%d}\n", (GetKeyState(VK_F24) & 0x8000) != 0); fflush(stdout);
                SendMessageW(nested_window, WM_APP + 1, 77, 0);
            }
            SetCapture(hwnd);
        }
        if (message == WM_LBUTTONUP) ReleaseCapture();
        return 0;
    }
    if (message == WM_CLOSE) { DestroyWindow(hwnd); return 0; }
    if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
    if (message == WM_TIMER) { PostQuitMessage(2); return 0; }
    return DefWindowProcW(hwnd, message, wparam, lparam);
}

static int target(void) {
    observe_request = CreateEventW(NULL, FALSE, FALSE, NULL);
    observe_done = CreateEventW(NULL, FALSE, FALSE, NULL);
    HANDLE observer = CreateThread(NULL, 0, observe_other_thread, NULL, 0, NULL);
    if (!observe_request || !observe_done || !observer) return 4;
    WNDCLASSW cls = {0}; cls.lpfnWndProc = probe_proc; cls.hInstance = GetModuleHandleW(NULL);
    cls.lpszClassName = L"BkaVirtualMouseProbe";
    if (!RegisterClassW(&cls)) return 2;
    HWND a = CreateWindowExW(0, cls.lpszClassName, L"VM target", WS_OVERLAPPEDWINDOW,
                            100, 100, 640, 480, NULL, NULL, cls.hInstance, NULL);
    HWND b = CreateWindowExW(0, cls.lpszClassName, L"VM other", WS_OVERLAPPEDWINDOW,
                            800, 100, 640, 480, NULL, NULL, cls.hInstance, NULL);
    if (!a || !b) return 3;
    nested_window = b;
    /* Never show or focus the probe windows. */
    activation_passthrough("unscoped-positioning", a);
    printf("{\"kind\":\"ready\",\"pid\":%lu,\"target\":\"%llu\",\"other\":\"%llu\"}\n",
           GetCurrentProcessId(), (unsigned long long)(uintptr_t)a, (unsigned long long)(uintptr_t)b);
    fflush(stdout);
    SetTimer(a, 1, 30000, NULL);
    MSG message;
    while (GetMessageW(&message, NULL, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
    InterlockedExchange(&observe_stop, 1); SetEvent(observe_request);
    WaitForSingleObject(observer, 3000);
    CloseHandle(observer); CloseHandle(observe_request); CloseHandle(observe_done);
    return 0;
}

static int check(int code, const char *step) {
    printf("{\"kind\":\"step\",\"step\":\"%s\",\"code\":%d,\"win32\":%lu}\n", step, code, GetLastError());
    fflush(stdout);
    return code;
}

int main(int argc, char **argv) {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    SetUnhandledExceptionFilter(crash);
    if (argc == 2 && strcmp(argv[1], "target") == 0) return target();
    if (argc < 4) return 2;
    HWND hwnd = (HWND)(uintptr_t)strtoull(argv[2], NULL, 10);
    HWND other = (HWND)(uintptr_t)strtoull(argv[3], NULL, 10);
    DWORD_PTR ignored;
    if (strcmp(argv[1], "close") == 0) { PostMessageW(hwnd, WM_CLOSE, 0, 0); return 0; }
    VmClient *mouse = NULL;
    POINT before, after; GetCursorPos(&before);
    int result = check(vm_open((uintptr_t)hwnd, 3000, &mouse), "create");
    if (result) return result;
    if (strcmp(argv[1], "abandon") == 0) return 0;
    VmClient *duplicate = NULL;
    if (vm_open((uintptr_t)hwnd, 3000, &duplicate) != VM_CONFLICT) { if (duplicate) vm_close(duplicate); result = 20; goto done; }
    result = check(vm_intercept(mouse, 1), "intercept");
    if (result) goto done;
    if (strcmp(argv[1], "abandon-intercepted") == 0) return 0;
    BYTE pointer_keys[256] = {0}; pointer_keys[VK_F24] = 0x80;
    result = check(vm_context(mouse, pointer_keys, 0, 17, 29, 0), "pointer-context"); if (result) goto done;
#define SEND(kind,x,y,buttons,button,dx,dy,label) \
    result = check(vm_event(mouse,kind,x,y,buttons,button,dx,dy),label); if (result) goto done
    SEND(VM_MOVE,17,29,0,0,0,0,"move");
    SEND(VM_DOWN,17,29,1,1,0,0,"down");
    SEND(VM_MOVE,50,60,1,0,0,0,"drag");
    SEND(VM_UP,50,60,0,1,0,0,"up");
    SEND(VM_WHEEL,50,60,0,0,0,120,"wheel");
    BYTE keys[256] = {0};
    keys[VK_SHIFT] = keys[VK_LSHIFT] = keys['A'] = 0x80;
    keys[VK_CAPITAL] = 1;
    keys[VK_F24] = 0x80;
    result = check(vm_context(mouse, keys, 7719, 73, 91, 1), "keyboard-context"); if (result) goto done;
    result = check(vm_key_event(mouse, 'A', 0, 1), "key-down"); if (result) goto done;
    SendMessageTimeoutW(hwnd, WM_APP + 3, 0, 0, SMTO_BLOCK | SMTO_ABORTIFHUNG, 3000, &ignored);
    keys['A'] = 0;
    result = check(vm_context(mouse, keys, 7719, 73, 91, 1), "keyboard-context-up"); if (result) goto done;
    result = check(vm_key_event(mouse, 'A', 0, 0), "key-up"); if (result) goto done;
    SendMessageTimeoutW(hwnd, WM_KEYDOWN, 'X', 1, SMTO_BLOCK | SMTO_ABORTIFHUNG, 3000, &ignored);
    SendMessageTimeoutW(hwnd, WM_APP + 2, 7719, 0, SMTO_BLOCK | SMTO_ABORTIFHUNG, 3000, &ignored);
    SendMessageTimeoutW(other, WM_KEYDOWN, 'Y', 1, SMTO_BLOCK | SMTO_ABORTIFHUNG, 3000, &ignored);
    if (vm_event(mouse, VM_WHEEL, 32767, 0, 0, 0, 0, 120) != VM_INVALID) { result = 21; goto done; }
    SendMessageTimeoutW(hwnd, WM_MOUSEMOVE, 0, MAKELPARAM(200,210), SMTO_BLOCK | SMTO_ABORTIFHUNG, 3000, &ignored);
    SendMessageTimeoutW(other, WM_MOUSEMOVE, 0, MAKELPARAM(201,211), SMTO_BLOCK | SMTO_ABORTIFHUNG, 3000, &ignored);
    SendMessageTimeoutW(hwnd, WM_APP + 1, 0, 0, SMTO_BLOCK | SMTO_ABORTIFHUNG, 3000, &ignored);
    result = check(vm_intercept(mouse, 0), "detach");
    if (result) goto done;
    SendMessageTimeoutW(hwnd, WM_MOUSEMOVE, 0, MAKELPARAM(202,212), SMTO_BLOCK | SMTO_ABORTIFHUNG, 3000, &ignored);
    result = check(vm_intercept(mouse, 1), "reattach");
    if (result) goto done;
    SEND(VM_MOVE,70,80,0,0,0,0,"move-after-reattach");
#undef SEND
done:
    vm_close(mouse);
    GetCursorPos(&after);
    printf("{\"kind\":\"done\",\"code\":%d,\"cursorUnchanged\":%s}\n", result,
           before.x == after.x && before.y == after.y ? "true" : "false");
    fflush(stdout);
    return result;
}
