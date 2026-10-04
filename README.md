# Snap the Board

A teacher photographs the whiteboard. A minute later, clean notes appear on a class page and
confirmed students get an email. Serverless on AWS: S3, Lambda, API Gateway, DynamoDB, SNS, Bedrock.

## Files

```
snap-the-board/
  template.yaml        All AWS resources (infrastructure as code)
  api/app.py           HTTP API: classes, students, uploads, notes
  process/app.py       Runs on each photo: reads the board, saves notes, sends email
  frontend/
    index.html         Landing page
    teacher.html/.js   Teacher console
    student.html/.js   Student notes page with photo/notes slider
    common.js          Shared helpers and the safe notes renderer
    style.css          Shared styles
    config.js          The only file you edit: your API address
  scripts/
    deploy.sh          Create or update everything
    pause.sh           Emergency stop (blocks all requests and photos)
    resume.sh          Undo pause.sh
    destroy.sh         Delete everything this project created
```

## Cost guards built in

- Nothing runs while idle: Lambda, API Gateway, DynamoDB (on-demand), S3 and SNS bill per use only.
- Hard cap of 30 photos read per day (`DAILY_LIMIT`), enforced in code. The only paid item is the AI call.
- Uploads over 3.5 MB are rejected by S3; photos are resized in the browser first.
- No automatic retries; duplicate events are ignored; API requests are throttled.
- Photos auto-delete after 30 days; logs after 14 days.

## Everyday commands (run in AWS CloudShell from the project folder)

```
bash scripts/deploy.sh     # create or update
bash scripts/pause.sh      # stop everything instantly
bash scripts/resume.sh     # start again
bash scripts/destroy.sh    # delete everything
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Page says it cannot reach the server | `frontend/config.js` has the wrong API address |
| Wrong or missing teacher passcode | Use the passcode you typed during deploy.sh |
| Board shows Failed: AccessDeniedException | Model not available in this region/account; test it in the Bedrock playground |
| Board shows Failed: ValidationException | Photo unreadable; retake it |
| No confirmation email | Check spam; add the student again to resend |
| Notes ready but no notes email | The student has not confirmed the subscription |
| Limit reached | The daily cap resets at 05:30 IST |
