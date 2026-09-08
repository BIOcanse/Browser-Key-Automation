#ifndef BKA_RECORDING_PROBE_WIRE_H
#define BKA_RECORDING_PROBE_WIRE_H
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <stdint.h>

/* Disposable route evidence, deliberately separate from the product protocol. */
#define RR_MAGIC 0x52525031u
#define RR_CAPACITY 256
#define RR_THREADS 4
#define RR_CONTROL L"BKA.RecordingProbe.Control.v1"
#define RR_OWNER L"BKA.RecordingProbe.Owner.v1"
#define RR_OWNER_TIME L"BKA.RecordingProbe.OwnerTime.v1"
enum { RR_ATTACH = 1, RR_DETACH = 2 };
enum { RR_BASELINE = 1, RR_WINDOW = 2, RR_INPUT = 3, RR_EXIT = 4, RR_ENTER = 5 };
enum { RR_CONTROL_PHASE = 1, RR_SENT_WINDOW_PHASE = 2, RR_QUEUE_REMOVE_PHASE = 3 };

typedef struct RrEvent {
    volatile LONG committed;
    uint32_t sequence, kind, phase, message, tid, message_time, dpi;
    uintptr_t hwnd, keyboard_layout;
    int64_t qpc;
    RECT window, client_screen;
    uint32_t visible, iconic, point_valid;
    int32_t x, y;
    uint64_t wparam, key_lparam;
    /* Copy WINDOWPOS/WM_DPICHANGED payloads now, never retain their pointers. */
    int32_t position_x, position_y, position_width, position_height;
    uint32_t position_flags;
    RECT suggested_rect;
} RrEvent;

typedef struct RrShared {
    uint32_t magic, bytes, owner_pid, target_pid, thread_count;
    DWORD thread_ids[RR_THREADS];
    uintptr_t root, token;
    uint64_t owner_created;
    volatile LONG enabled, next, lost, attached, detached, callbacks, mouse_inside;
    RrEvent events[RR_CAPACITY];
} RrShared;

static uint64_t rr_created(HANDLE process) {
    FILETIME created, exited, kernel, user;
    if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) return 0;
    return ((uint64_t)created.dwHighDateTime << 32) | created.dwLowDateTime;
}
#endif
