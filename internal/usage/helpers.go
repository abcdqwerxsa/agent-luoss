package usage

import (
	"context"

	"google.golang.org/grpc/metadata"
)

func mdRole(ctx context.Context) string {
	md, _ := metadata.FromIncomingContext(ctx)
	if v := md.Get("x-user-role"); len(v) > 0 {
		return v[0]
	}
	return ""
}
