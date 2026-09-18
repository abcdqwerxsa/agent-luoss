GOBIN := $(shell go env GOPATH)/bin
export PATH := $(GOBIN):$(PATH)

.PHONY: proto build tidy up down ps test

proto:
	protoc -I proto \
		--go_out=proto/gen --go_opt=module=agentluoss/proto/gen \
		--go-grpc_out=proto/gen --go-grpc_opt=module=agentluoss/proto/gen \
		proto/*.proto

build:
	go build ./...

tidy:
	go mod tidy

up:
	cd deploy && docker compose up -d

down:
	cd deploy && docker compose down

ps:
	cd deploy && docker compose ps

test:
	go test ./...
