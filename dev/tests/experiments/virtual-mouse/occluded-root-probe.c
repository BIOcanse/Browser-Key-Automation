#define COBJMACROS
#include "wire.h"
#include <oleacc.h>
#include <uiautomationclient.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

// Disposable fixture consumer of the real backend. The random title identifies
// one test window; calibration is valid only while that exact geometry remains.
static HWND root, content;
static unsigned roots, contents;
static const char *marker;
static double css_width, css_height;
static unsigned accessible_visited, document_candidates, documents;
static RECT document_rect;
static RECT ancestor_rect;
static unsigned ancestor_candidates;
static RECT accessible_path[33];
static LONG role_path[33];
static IAccessible *object_path[33]; // Borrowed from the active explicit DFS stack.
static IUIAutomation2 *automation;

static void describe_uia(IAccessible *object, unsigned depth) {
    if (!automation) return;
    IUIAutomationElement *element = NULL;
    HRESULT result = IUIAutomation2_ElementFromIAccessible(automation, object, CHILDID_SELF, &element);
    BSTR class_name = NULL, automation_id = NULL;
    CONTROLTYPEID type = 0; RECT rect = {0};
    if (SUCCEEDED(result) && element) {
        IUIAutomationElement_get_CurrentClassName(element, &class_name);
        IUIAutomationElement_get_CurrentAutomationId(element, &automation_id);
        IUIAutomationElement_get_CurrentControlType(element, &type);
        IUIAutomationElement_get_CurrentBoundingRectangle(element, &rect);
    }
    fprintf(stderr, "uia depth=%u result=%ld type=%ld class=%ls id=%ls rect=%ld,%ld,%ld,%ld\n", depth, result, (long)type,
        class_name ? class_name : L"<null>", automation_id ? automation_id : L"<null>", rect.left, rect.top, rect.right, rect.bottom);
    SysFreeString(class_name); SysFreeString(automation_id);
    if (element) IUIAutomationElement_Release(element);
}

static int inspect_document(IAccessible *object, unsigned depth) {
    ++accessible_visited;
    VARIANT self, role; VariantInit(&self); VariantInit(&role);
    self.vt = VT_I4; self.lVal = CHILDID_SELF;
    BSTR name = NULL;
    IAccessible_get_accRole(object, self, &role);
    IAccessible_get_accName(object, self, &name);
    LONG path_x = 0, path_y = 0, path_width = 0, path_height = 0;
    IAccessible_accLocation(object, &path_x, &path_y, &path_width, &path_height, self);
    accessible_path[depth] = (RECT){path_x, path_y, path_width, path_height};
    role_path[depth] = role.vt == VT_I4 ? role.lVal : -1;
    object_path[depth] = object;
    wchar_t expected[128]; size_t length = strlen(marker);
    for (size_t i = 0; i <= length; ++i) expected[i] = (unsigned char)marker[i];
    int is_document = role.vt == VT_I4 && role.lVal == ROLE_SYSTEM_DOCUMENT;
    if (is_document) {
        ++document_candidates; fprintf(stderr, "document name=%ls\n", name ? name : L"<null>");
        HWND native = NULL;
        HRESULT native_result = WindowFromAccessibleObject(object, &native);
        RECT native_rect = {0}, native_client = {0}; POINT local = {0};
        if (native) { GetWindowRect(native, &native_rect); GetClientRect(native, &native_client); MapWindowPoints(native, GetParent(native), &local, 1); }
        fprintf(stderr, "document native=%llu result=%ld screen=%ld,%ld,%ld,%ld client=%ld,%ld parentOffset=%ld,%ld\n",
            (unsigned long long)(uintptr_t)native, native_result, native_rect.left, native_rect.top, native_rect.right, native_rect.bottom, native_client.right, native_client.bottom, local.x, local.y);
        for (unsigned i = depth > 8 ? depth - 8 : 0; i <= depth; ++i) {
            RECT r = accessible_path[i]; fprintf(stderr, "ancestor depth=%u role=%ld rect=%ld,%ld,%ld,%ld\n", i, role_path[i], r.left, r.top, r.right, r.bottom);
            describe_uia(object_path[i], i);
        }
        // Record the nearest nonempty viewport-shaped ancestor as evidence,
        // not as an accepted input region or a replacement document identity.
        for (unsigned i = depth; i > 0; --i) {
            RECT r = accessible_path[i - 1];
            if (r.right > 0 && r.bottom > 0 && fabs(r.right * css_height - r.bottom * css_width) <= 2 * (css_width + css_height)) {
                ++ancestor_candidates;
                ancestor_rect = (RECT){r.left, r.top, r.left + r.right, r.top + r.bottom};
                break;
            }
        }
    }
    if (is_document) {
        LONG x, y, width, height;
        if (SUCCEEDED(IAccessible_accLocation(object, &x, &y, &width, &height, self))) {
            fprintf(stderr, "document rect=%ld,%ld,%ld,%ld nameMatches=%d\n", x, y, width, height, name && wcsstr(name, expected) != NULL);
            if (width > 0 && height > 0 && fabs(width * css_height - height * css_width) <= 2 * (css_width + css_height)) {
                ++documents; document_rect = (RECT){x, y, x + width, y + height};
            }
        }
    }
    SysFreeString(name); VariantClear(&role);
    return is_document; // Do not enumerate page payload or nested documents.
}
static void find_document(IAccessible *root_object) {
    typedef struct Frame { IAccessible *object; LONG next, count; } Frame;
    Frame stack[33] = {{.object = root_object, .next = -1}};
    IUnknown *identities[1024]; unsigned seen = 0, depth = 1, enumerated = 0;
    ULONGLONG deadline = GetTickCount64() + 2000;
    IAccessible_AddRef(root_object);
    while (depth && seen < 1024 && enumerated < 4096 && GetTickCount64() < deadline) {
        Frame *frame = &stack[depth - 1];
        if (frame->next == -1) {
            IUnknown *identity = NULL; int duplicate = 0;
            if (SUCCEEDED(IAccessible_QueryInterface(frame->object, &IID_IUnknown, (void **)&identity))) {
                for (unsigned i = 0; i < seen; ++i) if (identities[i] == identity) { duplicate = 1; break; }
            }
            if (!identity || duplicate) {
                if (identity) IUnknown_Release(identity);
                IAccessible_Release(frame->object); --depth; continue;
            }
            identities[seen++] = identity; // Retain identity until traversal ends.
            if (inspect_document(frame->object, depth - 1) || depth == 33) {
                IAccessible_Release(frame->object); --depth; continue;
            }
            frame->next = 0; frame->count = 0;
            IAccessible_get_accChildCount(frame->object, &frame->count);
        }
        if (frame->next >= frame->count) { IAccessible_Release(frame->object); --depth; continue; }
        VARIANT child; VariantInit(&child); LONG obtained = 0;
        HRESULT result = AccessibleChildren(frame->object, frame->next++, 1, &child, &obtained);
        ++enumerated;
        if (SUCCEEDED(result) && obtained == 1 && child.vt == VT_DISPATCH && child.pdispVal) {
            IAccessible *object = NULL;
            if (SUCCEEDED(IDispatch_QueryInterface(child.pdispVal, &IID_IAccessible, (void **)&object)))
                stack[depth++] = (Frame){.object = object, .next = -1};
        }
        VariantClear(&child);
    }
    while (depth) IAccessible_Release(stack[--depth].object);
    while (seen) IUnknown_Release(identities[--seen]);
}
static void measure_document(int target_dpi, int use_uia) {
    DPI_AWARENESS_CONTEXT previous_dpi = NULL;
    if (target_dpi) previous_dpi = SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(root));
    IAccessible *object = NULL;
    HRESULT initialized = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    HRESULT uia_result = use_uia ? CoCreateInstance(&CLSID_CUIAutomation8, NULL, CLSCTX_INPROC_SERVER, &IID_IUIAutomation2, (void **)&automation) : S_FALSE;
    if (automation) {
        IUIAutomation2_put_ConnectionTimeout(automation, 500);
        IUIAutomation2_put_TransactionTimeout(automation, 500);
    }
    fprintf(stderr, "uia initialized=%ld\n", uia_result);
    accessible_visited = document_candidates = documents = ancestor_candidates = 0;
    document_rect = ancestor_rect = (RECT){0};
    HRESULT result = AccessibleObjectFromWindow(root, OBJID_CLIENT, &IID_IAccessible, (void **)&object);
    if (SUCCEEDED(result)) { find_document(object); IAccessible_Release(object); }
    POINT p = {document_rect.left, document_rect.top}; ScreenToClient(root, &p);
    POINT ancestor = {ancestor_rect.left, ancestor_rect.top}; ScreenToClient(root, &ancestor);
    RECT native_client = {0}, legacy_client = {0}; POINT native_origin = {0}, legacy_origin = {0};
    GetClientRect(root, &native_client); GetClientRect(content, &legacy_client);
    ClientToScreen(root, &native_origin); ClientToScreen(content, &legacy_origin);
    printf("{\"measureResult\":%ld,\"visited\":%u,\"documentCandidates\":%u,\"documents\":%u,\"offset\":[%ld,%ld],\"viewport\":[%ld,%ld],\"legacyVisible\":%s,\"targetDpi\":%s,\"dpi\":%u,\"cssViewport\":[%.3f,%.3f],\"nativeOrigin\":[%ld,%ld],\"nativeClient\":[%ld,%ld],\"legacyOrigin\":[%ld,%ld],\"legacyClient\":[%ld,%ld],\"ancestorCandidates\":%u,\"ancestorOffset\":[%ld,%ld],\"ancestorSize\":[%ld,%ld]}\n",
        result, accessible_visited, document_candidates, documents, p.x, p.y, document_rect.right - document_rect.left, document_rect.bottom - document_rect.top, IsWindowVisible(content) ? "true" : "false",
        target_dpi ? "true" : "false", GetDpiForWindow(root), css_width, css_height, native_origin.x, native_origin.y, native_client.right, native_client.bottom,
        legacy_origin.x, legacy_origin.y, legacy_client.right, legacy_client.bottom, ancestor_candidates, ancestor.x, ancestor.y,
        ancestor_rect.right - ancestor_rect.left, ancestor_rect.bottom - ancestor_rect.top);
    if (automation) { IUIAutomation2_Release(automation); automation = NULL; }
    if (SUCCEEDED(initialized)) CoUninitialize();
    if (previous_dpi) SetThreadDpiAwarenessContext(previous_dpi);
}
static int class_is(HWND w, const wchar_t *name) {
    wchar_t buffer[128];
    return GetClassNameW(w, buffer, 128) && !wcscmp(buffer, name);
}
static int title_matches(HWND w) {
    wchar_t title[256], expected[128];
    size_t length = strlen(marker);
    if (length >= 128) return 0;
    for (size_t i = 0; i <= length; ++i) expected[i] = (unsigned char)marker[i];
    return GetWindowTextW(w, title, 256) && wcsstr(title, expected);
}
static BOOL CALLBACK find_root(HWND w, LPARAM unused) {
    (void)unused;
    if (class_is(w, L"Chrome_WidgetWin_1") && IsWindowVisible(w) && title_matches(w)) { root = w; ++roots; }
    return TRUE;
}
static int active_content(HWND candidate, const RECT *r) {
    POINT p = {r->right / 2, r->bottom / 2};
    MapWindowPoints(candidate, root, &p, 1);
    HWND parent = root;
    for (unsigned depth = 0; depth < 64; ++depth) {
        HWND child = ChildWindowFromPointEx(parent, p, CWP_SKIPINVISIBLE | CWP_SKIPDISABLED);
        if (child == candidate) return 1;
        if (!child || child == parent) return 0;
        MapWindowPoints(parent, child, &p, 1);
        parent = child;
    }
    return 0;
}
static BOOL CALLBACK find_content(HWND w, LPARAM unused) {
    (void)unused;
    if (!class_is(w, L"Chrome_RenderWidgetHostHWND") || !IsWindowVisible(w) || GetAncestor(w, GA_ROOT) != root) return TRUE;
    RECT r;
    if (GetClientRect(w, &r) && r.right > 0 && r.bottom > 0 &&
        fabs(r.right * css_height - r.bottom * css_width) <= 2 * (css_width + css_height) && active_content(w, &r)) {
        content = w; ++contents;
    }
    return TRUE;
}
int main(int argc, char **argv) {
    SetErrorMode(0x8003);
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    setvbuf(stdout, NULL, _IONBF, 0);
    if (argc != 6) return 2;
    marker = argv[1]; css_width = atof(argv[2]); css_height = atof(argv[3]);
    double x = atof(argv[4]), y = atof(argv[5]);
    if (css_width <= 0 || css_height <= 0 || x < 0 || x >= css_width || y < 0 || y >= css_height) return 2;
    // The fixture sets the renderer title first; the native title propagates
    // asynchronously. This bounded calibration phase precedes all input.
    ULONGLONG deadline = GetTickCount64() + 2000;
    do {
        root = NULL; roots = 0;
        EnumWindows(find_root, 0);
        if (roots == 1) break;
        Sleep(10);
    } while (GetTickCount64() < deadline);
    if (roots != 1) { fprintf(stderr, "calibration: roots=%u\n", roots); return 3; }
    EnumChildWindows(root, find_content, 0);
    if (contents != 1) { fprintf(stderr, "calibration: active contents=%u root=%llu\n", contents, (unsigned long long)(uintptr_t)root); return 4; }
    RECT outer, viewport, window_rect;
    POINT offset = {0,0};
    GetClientRect(root, &outer); GetClientRect(content, &viewport); GetWindowRect(root, &window_rect);
    MapWindowPoints(content, root, &offset, 1);
    int px = offset.x + (int)round(x * viewport.right / css_width);
    int py = offset.y + (int)round(y * viewport.bottom / css_height);
    VmClient *client = NULL;
    HWND cover_window = NULL;
    int result = VM_OK;
    printf("{\"ready\":true,\"root\":%llu,\"content\":%llu,\"offset\":[%ld,%ld],\"viewport\":[%ld,%ld],\"point\":[%d,%d]}\n",
        (unsigned long long)(uintptr_t)root, (unsigned long long)(uintptr_t)content, offset.x, offset.y, viewport.right, viewport.bottom, px, py);
    char line[128];
    while (fgets(line, sizeof(line), stdin)) {
        if (!strcmp(line, "state\n")) {
            RECT current = {0}, covered = {0}; GetWindowRect(root, &current);
            BOOL has_cover = cover_window && IsWindowVisible(cover_window) && GetWindowRect(cover_window, &covered);
            BOOL still_covered = has_cover && (GetWindowLongPtrW(cover_window, GWL_EXSTYLE) & WS_EX_TOPMOST) &&
                !(GetWindowLongPtrW(root, GWL_EXSTYLE) & WS_EX_TOPMOST) && covered.left <= current.left && covered.top <= current.top &&
                covered.right >= current.right && covered.bottom >= current.bottom;
            printf("{\"foreground\":%llu,\"rootUnchanged\":%s,\"covered\":%s,\"legacyVisible\":%s}\n",
                (unsigned long long)(uintptr_t)GetForegroundWindow(), IsWindow(root) && !memcmp(&current, &window_rect, sizeof(RECT)) ? "true" : "false",
                still_covered ? "true" : "false", IsWindowVisible(content) ? "true" : "false");
            continue;
        }
        if (!strcmp(line, "measure\n")) { measure_document(0, 0); continue; }
        if (!strcmp(line, "measure-target-dpi\n")) { measure_document(1, 0); continue; }
        if (!strcmp(line, "measure-uia\n")) { measure_document(1, 1); continue; }
        if (!strncmp(line, "cover ", 6)) {
            const char *saved_marker = marker;
            HWND saved_root = root;
            line[strcspn(line, "\r\n")] = 0; marker = line + 6;
            ULONGLONG cover_deadline = GetTickCount64() + 2000;
            do {
                roots = 0; EnumWindows(find_root, 0);
                if (roots == 1) break;
                Sleep(10);
            } while (GetTickCount64() < cover_deadline);
            HWND cover = roots == 1 ? root : NULL;
            cover_window = cover;
            root = saved_root; marker = saved_marker;
            BOOL raised = cover && cover != root && SetWindowPos(cover, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            RECT r = {0}; if (cover) GetWindowRect(cover, &r);
            printf("{\"coverRaised\":%s,\"coversRoot\":%s,\"cover\":%llu}\n", raised ? "true" : "false",
                raised && r.left <= window_rect.left && r.top <= window_rect.top && r.right >= window_rect.right && r.bottom >= window_rect.bottom ? "true" : "false",
                (unsigned long long)(uintptr_t)cover);
            continue;
        }
        if (strcmp(line, "click\n")) break;
        HWND foreground_before = GetForegroundWindow();
        HWND foreground_attach = NULL, foreground_move = NULL, foreground_down = NULL;
        BOOL legacy_visible_before = IsWindowVisible(content);
        RECT current, current_window, current_content;
        if (!title_matches(root) || !GetClientRect(root, &current) || memcmp(&current, &outer, sizeof(RECT)) ||
            !GetWindowRect(root, &current_window) || memcmp(&current_window, &window_rect, sizeof(RECT)) ||
            !GetClientRect(content, &current_content) || memcmp(&current_content, &viewport, sizeof(RECT))) result = VM_TARGET_LOST;
        else {
            uint8_t keys[256] = {0};
            result = vm_open((uintptr_t)root, 2000, &client);
            foreground_attach = GetForegroundWindow();
            if (result == VM_OK) { vm_begin(client, 2000); result = vm_context(client, keys, 0, px, py, 0); }
            if (result == VM_OK) result = vm_event(client, VM_MOVE, px, py, 0, 0, 0, 0);
            foreground_move = GetForegroundWindow();
            if (result == VM_OK) result = vm_event(client, VM_DOWN, px, py, 1, 1, 0, 0);
            foreground_down = GetForegroundWindow();
            if (result == VM_OK) result = vm_event(client, VM_UP, px, py, 0, 1, 0, 0);
        }
        HWND foreground_after = GetForegroundWindow();
        printf("{\"result\":%d,\"foregroundAttach\":%llu,\"foregroundMove\":%llu,\"foregroundDown\":%llu,\"foregroundBefore\":%llu,\"foregroundAfter\":%llu,\"foregroundUnchanged\":%s,\"legacyVisibleBefore\":%s,\"legacyVisibleAfter\":%s}\n", result,
            (unsigned long long)(uintptr_t)foreground_attach, (unsigned long long)(uintptr_t)foreground_move, (unsigned long long)(uintptr_t)foreground_down,
            (unsigned long long)(uintptr_t)foreground_before, (unsigned long long)(uintptr_t)foreground_after,
            foreground_before == foreground_after ? "true" : "false", legacy_visible_before ? "true" : "false", IsWindowVisible(content) ? "true" : "false");
        break;
    }
    if (client) vm_close(client);
    return result == VM_OK ? 0 : 6;
}
