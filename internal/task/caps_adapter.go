// Caps adapter: task-svc -> caps-svc client implementing CapsResolver.
package task

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	capspb "agentluoss/proto/gen/caps"
)

type CapsAdapter struct{ cl capspb.CapsClient }

func NewCapsAdapter(addr string) (*CapsAdapter, error) {
	cc, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, err
	}
	return &CapsAdapter{cl: capspb.NewCapsClient(cc)}, nil
}

func (a *CapsAdapter) EffectiveCaps(ctx context.Context, userID, expertID string) (*capspb.GetEffectiveCapsResponse, error) {
	return a.cl.GetEffectiveCaps(ctx, &capspb.GetEffectiveCapsRequest{UserId: userID, ExpertId: expertID})
}
