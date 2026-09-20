// Per-IP token bucket rate limiting (in-memory; good enough for one gateway
// replica — swap for redis-based limiter when gateway is scaled horizontally).
package gateway

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/time/rate"
)

type ipLimiter struct {
	mu       sync.Mutex
	limiters map[string]*entry
}

type entry struct {
	lim  *rate.Limiter
	last time.Time
}

func newIPLimiter(r rate.Limit, burst int) *ipLimiter {
	l := &ipLimiter{limiters: map[string]*entry{}}
	go func() {
		for range time.Tick(5 * time.Minute) {
			l.mu.Lock()
			for ip, e := range l.limiters {
				if time.Since(e.last) > 10*time.Minute {
					delete(l.limiters, ip)
				}
			}
			l.mu.Unlock()
		}
	}()
	return l
}

func (l *ipLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.limiters[ip]
	if !ok {
		e = &entry{lim: rate.NewLimiter(30, 60)} // 30 rps, burst 60
		l.limiters[ip] = e
	}
	e.last = time.Now()
	return e.lim.Allow()
}

func (a *App) rateLimit() gin.HandlerFunc {
	l := newIPLimiter(30, 60)
	return func(c *gin.Context) {
		if !l.allow(c.ClientIP()) {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "rate limited"})
			return
		}
		c.Next()
	}
}
