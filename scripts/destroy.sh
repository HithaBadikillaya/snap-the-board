#!/usr/bin/env bash
# Deletes EVERYTHING this project created in AWS. Use it when the project is over.
# All classes, rosters, notes and photos are removed. This cannot be undone.
#   bash scripts/destroy.sh
set -euo pipefail
STACK="snap-the-board"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-south-1}}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"

read -rp "Type DELETE to remove the whole project from region $REGION: " answer
[[ "$answer" == "DELETE" ]] || { echo "Cancelled."; exit 1; }

echo "Emptying the photo bucket..."
aws s3 rm "s3://snap-board-${ACCOUNT}-${REGION}" --recursive --region "$REGION" || true

echo "Deleting the stack (about 1 minute)..."
aws cloudformation delete-stack --stack-name "$STACK" --region "$REGION"
aws cloudformation wait stack-delete-complete --stack-name "$STACK" --region "$REGION"

echo "Deleting class email topics..."
for arn in $(aws sns list-topics --region "$REGION" \
    --query "Topics[?contains(TopicArn, ':snap-class-')].TopicArn" --output text); do
  aws sns delete-topic --topic-arn "$arn" --region "$REGION"
done

echo "Deleting the upload-package bucket..."
aws s3 rb "s3://snap-board-artifacts-${ACCOUNT}-${REGION}" --force --region "$REGION" || true

echo "Everything is deleted."
