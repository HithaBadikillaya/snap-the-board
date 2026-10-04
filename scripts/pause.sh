#!/usr/bin/env bash
# Emergency stop: blocks every request and every photo. Nothing is deleted.
#   bash scripts/pause.sh      (undo with: bash scripts/resume.sh)
set -euo pipefail
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-south-1}}"
for fn in snap-the-board-api snap-the-board-process; do
  aws lambda put-function-concurrency --function-name "$fn" \
    --reserved-concurrent-executions 0 --region "$REGION" >/dev/null
  echo "Paused $fn"
done
echo "The app is paused. Run scripts/resume.sh to turn it back on."
