package main

import "sort"

// The programs that go through the VPN — a list of its own for the server and for a bridge, as the two are for
// different things. Through the server: the programs of the sites and services that need it (the browsers too, but
// Russian sites in them go straight, as without the VPN: banks, Gosuslugi). Through a bridge (the days the mobile
// network lets only a list of sites through, and the bridge is slow): the messengers, the AI chats and the browsers,
// no music or video programs. The standard ones are ticked from the start; any other program can be ticked too, any of
// them unticked, or everything sent through.
var standardApps = map[bool][]string{
	false: {"telegram.exe", "whatsapp.exe", "whatsapp.root.exe", "discord.exe", "signal.exe", "viber.exe", "chatgpt.exe",
		"claude.exe", "spotify.exe", "chrome.exe", "msedge.exe", "firefox.exe", "opera.exe"},
	true: {"telegram.exe", "whatsapp.exe", "whatsapp.root.exe", "signal.exe", "viber.exe", "chatgpt.exe", "claude.exe",
		"chrome.exe", "msedge.exe", "firefox.exe", "opera.exe"},
}

// For: the programs a connection of this kind carries (bridge: a bridge's list), sorted; nil: all of them.
func (s Settings) For(bridge bool) []string {
	only, apps := s.OnlyApps, s.Apps
	if bridge {
		only, apps = s.BridgeOnly, s.BridgeApps
	}
	if !only || len(apps) == 0 {
		return nil
	}
	out := append([]string(nil), apps...)
	sort.Strings(out)
	return out
}

// twoLists: Winger before 1.0.140 had one list, and «all programs» from the start; now the server's and a bridge's,
// the standard ones ticked. A list chosen before stays the server's; «all programs» (most likely never chosen, the old
// start) becomes the standard list. Whether anything changed.
func twoLists(s *Settings) bool {
	if s.AppsSet >= 1 {
		return false
	}
	if !s.OnlyApps || len(s.Apps) == 0 {
		s.OnlyApps, s.Apps = true, append([]string(nil), standardApps[false]...)
	}
	s.BridgeOnly, s.BridgeApps = true, append([]string(nil), standardApps[true]...)
	s.AppsSet = 1
	return true
}
