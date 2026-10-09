//go:build windows

package main

import (
	"time"

	"golang.org/x/sys/windows/svc"
)

type wingerService struct{}

// Execute: the service's life — the engine and the window's API while it runs; off when Windows stops it.
func (wingerService) Execute(_ []string, req <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	stop := make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- serve(true, stop) }()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case c := <-req:
			switch c.Cmd {
			case svc.Interrogate:
				status <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				close(stop)
				select {
				case <-done:
				case <-time.After(15 * time.Second):
				}
				return false, 0
			}
		case err := <-done:
			if err != nil {
				Logf("service: %v", err)
				return false, 1
			}
			return false, 0
		}
	}
}

func runService() error {
	return svc.Run(serviceName, wingerService{})
}
