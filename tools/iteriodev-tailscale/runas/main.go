// runas UID:GID PROGRAM [ARGS...]: drop root to a numeric uid/gid and exec PROGRAM.
// The unit's systemd (237) refuses User= for a uid without an /etc/passwd entry, and the unit's busybox has no
// setpriv / chroot --userspec, so the service starts as root and this drops to 3910 (no account needed).
package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
)

func main() {
	if len(os.Args) < 3 {
		fail(fmt.Errorf("usage: runas UID:GID PROGRAM [ARGS...]"))
	}
	ids := strings.SplitN(os.Args[1], ":", 2)
	if len(ids) != 2 {
		fail(fmt.Errorf("want UID:GID, got %q", os.Args[1]))
	}
	uid, err1 := strconv.Atoi(ids[0])
	gid, err2 := strconv.Atoi(ids[1])
	if err1 != nil || err2 != nil || uid <= 0 || gid <= 0 {
		fail(fmt.Errorf("want numeric non-root UID:GID, got %q", os.Args[1]))
	}
	// groups first, then gid, then uid (after setuid the others are no longer allowed)
	if err := syscall.Setgroups([]int{gid}); err != nil {
		fail(err)
	}
	if err := syscall.Setgid(gid); err != nil {
		fail(err)
	}
	if err := syscall.Setuid(uid); err != nil {
		fail(err)
	}
	if os.Getuid() != uid || os.Geteuid() != uid {
		fail(fmt.Errorf("still uid %d", os.Geteuid()))
	}
	fail(syscall.Exec(os.Args[2], os.Args[2:], os.Environ()))
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "runas:", err)
	os.Exit(1)
}
