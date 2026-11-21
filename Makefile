VERSION ?= dev
PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64
.PHONY: test vet smoke dist clean

test:
	cd go && CGO_ENABLED=0 go test ./...

vet:
	cd go && CGO_ENABLED=0 go vet ./...

smoke:
	./scripts/smoke.sh

dist:
	@set -e; mkdir -p dist; for target in $(PLATFORMS); do os=$${target%/*}; arch=$${target#*/}; ext=; [ "$$os" = windows ] && ext=.exe; echo "Building $$os/$$arch"; (cd go && CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o ../dist/mcp-$$os-$$arch$$ext ./cmd/mcp); done

clean:
	rm -rf dist
