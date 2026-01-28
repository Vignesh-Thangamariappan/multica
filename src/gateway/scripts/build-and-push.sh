#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GATEWAY_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(cd "$GATEWAY_DIR/../.." && pwd)"

REPO="085931705009.dkr.ecr.us-west-2.amazonaws.com/super-multica/gateway"
BRANCH="$(git symbolic-ref --short -q HEAD | tr '/' '-')"
IMAGE_TAG="$(date +%F_%H-%M-%S)-${BRANCH}-$(git rev-parse --short HEAD)"
IMAGE="$REPO:$IMAGE_TAG"

# Determine if sudo is needed for docker commands
if [[ "$(uname -s)" == "Linux" ]]; then
    DOCKER_CMD="sudo docker"
else
    DOCKER_CMD="docker"
fi

echo "Building image: $IMAGE"
echo "Using Dockerfile: $GATEWAY_DIR/Dockerfile"
echo "Build context: $PROJECT_ROOT"

# Login to ECR
aws ecr get-login-password --region us-west-2 | $DOCKER_CMD login --username AWS --password-stdin 085931705009.dkr.ecr.us-west-2.amazonaws.com

# Build from project root with gateway Dockerfile
$DOCKER_CMD build -f "$GATEWAY_DIR/Dockerfile" -t "$IMAGE" "$PROJECT_ROOT"
$DOCKER_CMD push "$IMAGE"

echo ""
echo "Successfully pushed: $IMAGE"
