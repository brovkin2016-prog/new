//go:build race

package rtc

// raceBound: per cent of resends a lossless wire may show; the race detector's stalls make some look due
const raceBound = 3
