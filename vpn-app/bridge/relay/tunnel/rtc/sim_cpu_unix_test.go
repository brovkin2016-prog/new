//go:build unix

package rtc

import (
	"syscall"
	"time"
)

// processCPU: the CPU time (user + system) this process used so far. winger: both sides run in this one process, so
// the bench's CPU per delivered megabyte is the creator's and the joiner's together (plus the model's own wires).
func processCPU() time.Duration {
	var ru syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &ru) != nil {
		return 0
	}
	return time.Duration(ru.Utime.Nano() + ru.Stime.Nano())
}
