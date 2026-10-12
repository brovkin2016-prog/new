package joiner

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// winger: the check's own calls through /generic_proxy go out as from VK's page, its cookies stay on this page, a
// passed check's token is taken by the program itself, and what did not come is told in the journal
func TestGenericProxyLikeThePage(t *testing.T) {
	var mu sync.Mutex
	var origins, referers []string
	vk := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		origins = append(origins, r.Header.Get("Origin"))
		referers = append(referers, r.Header.Get("Referer"))
		mu.Unlock()
		if strings.Contains(r.URL.Path, "captchaNotRobot.check") {
			http.SetCookie(w, &http.Cookie{Name: "remixstlid", Value: "1", Domain: ".vk.ru", Secure: true, SameSite: http.SameSiteNoneMode})
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"response":{"status":"OK","success_token":"tok123"}}`)
			return
		}
		fmt.Fprint(w, "<html><head></head><body>check</body></html>")
	}))
	defer vk.Close()
	var logMu sync.Mutex
	var logged []string
	captchaLog = func(f string, a ...any) { logMu.Lock(); logged = append(logged, fmt.Sprintf(f, a...)); logMu.Unlock() }
	defer func() { captchaLog = func(string, ...any) {} }()

	port := StartCaptchaProxy(vk.URL+"/not_robot_captcha?session=1", nil)
	if port == 0 {
		t.Fatal("no proxy")
	}
	defer StopCaptchaProxy()
	local := fmt.Sprintf("http://127.0.0.1:%d", port)

	call := local + "/generic_proxy?proxy_url=" + url.QueryEscape(vk.URL+"/method/captchaNotRobot.check?v=5.282")
	req, _ := http.NewRequest("POST", call, strings.NewReader("hash=x"))
	req.Header.Set("Origin", local)
	req.Header.Set("Referer", local+"/not_robot_captcha?session=1")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if !strings.Contains(string(body), "tok123") {
		t.Fatalf("the page did not get VK's answer: %s", body)
	}
	mu.Lock()
	if origins[0] != vk.URL || referers[0] != vk.URL+"/not_robot_captcha?session=1" {
		t.Fatalf("went out as from 127.0.0.1: origin %q referer %q", origins[0], referers[0])
	}
	mu.Unlock()
	ck := res.Header.Get("Set-Cookie")
	if ck == "" || strings.Contains(strings.ToLower(ck), "domain=") || strings.Contains(strings.ToLower(ck), "secure") {
		t.Fatalf("the check's cookie would not stay on this page: %q", ck)
	}
	got := make(chan string, 1)
	go func() { got <- GetCaptchaResult() }()
	select {
	case tok := <-got:
		if tok != "tok123" {
			t.Fatalf("token %q", tok)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the passed check's token was not taken by the program")
	}

	// a host that does not answer: the page gets 502 at once, the journal says which
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	dead := ln.Addr().String()
	ln.Close()
	res, err = http.Get(local + "/generic_proxy?proxy_url=" + url.QueryEscape("http://"+dead+"/method/captchaNotRobot.getContent?sid=secret"))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadGateway {
		t.Fatalf("status %d", res.StatusCode)
	}
	logMu.Lock()
	all := strings.Join(logged, "\n")
	logMu.Unlock()
	if !strings.Contains(all, "/method/captchaNotRobot.check -> 200") || !strings.Contains(all, dead+"/method/captchaNotRobot.getContent failed") {
		t.Fatalf("journal:\n%s", all)
	}
	if strings.Contains(all, "secret") || strings.Contains(all, "v=5.282") {
		t.Fatalf("a query got into the journal:\n%s", all)
	}
}
