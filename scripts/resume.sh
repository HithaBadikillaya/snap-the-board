#!/usr/bin/env bash
# Turns the app back on after pause.sh.
set -euo pipefail
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-south-1}}"
for fn in snap-the-board-api snap-the-board-process; do
  aws lambda delete-function-concurrency --function-name "$fn" --region "$REGION"
  echo "Resumed $fn"
done
echo "The app is running again."
