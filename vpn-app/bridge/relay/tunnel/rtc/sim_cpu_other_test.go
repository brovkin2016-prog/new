//go:build !unix

package rtc

import "time"

// processCPU: not measured here (the bench reports CPU on unix systems only).
func processCPU() time.Duration { return 0 }
