#ifndef BKA_RECORDING_TYPES_H
#define BKA_RECORDING_TYPES_H
#include <stdint.h>

#define RC_MAX_THREADS 8
#define RC_MAX_CONTEXTS 32
#define RC_MAX_CAPACITY 65536
enum { RC_BASELINE = 1, RC_WINDOW = 2, RC_INPUT = 3, RC_EXIT = 4, RC_ENTER = 5 };
enum { RC_CONTROL_PHASE = 1, RC_SENT_WINDOW_PHASE = 2, RC_QUEUE_REMOVE_PHASE = 3,
    RC_LOW_LEVEL_PHASE = 4, RC_WIN_EVENT_PHASE = 5 };
enum { RC_RUNNING = 0, RC_STOPPED = 1, RC_EXPIRED = 2, RC_OVERFLOW = 3,
    RC_TARGET_LOST = 4, RC_GEOMETRY_LOST = 5, RC_THREADS_CHANGED = 6, RC_START_FAILED = 7 };
typedef struct RcRect { int32_t left, top, right, bottom; } RcRect;
typedef struct RcEvent {
    uint32_t sequence, kind, phase, message, tid, message_time, dpi;
    uintptr_t hwnd, keyboard_layout;
    int64_t qpc;
    RcRect window, client_screen, content_screen;
    uint32_t visible, iconic, point_valid, content_valid;
    int32_t x, y;
    uint64_t wparam, key_lparam;
    int32_t position_x, position_y, position_width, position_height;
    uint32_t position_flags;
    RcRect suggested_rect;
} RcEvent;
#endif
