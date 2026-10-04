"""Snap the Board - HTTP API. One Lambda with a small router.

Public routes (students):   GET /classes/{id}, GET /classes/{id}/notes
Teacher routes (passcode):  everything else. The passcode travels in the
x-teacher-key header and is compared against a SHA-256 hash.
"""
import hashlib
import hmac
import json
import os
import re
import time
import traceback
import uuid
from urllib.parse import unquote

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.config import Config
from botocore.exceptions import ClientError

REGION = os.environ["AWS_REGION"]
BUCKET = os.environ["BUCKET_NAME"]
KEY_HASH = os.environ["TEACHER_KEY_HASH"]
DAILY_LIMIT = int(os.environ["DAILY_LIMIT"])

MAX_IMAGE_BYTES = 3_500_000      # Bedrock accepts up to about 3.75 MB per image
MAX_CLASSES = 20
MAX_STUDENTS = 500
MAX_EMAILS_PER_REQUEST = 50

ID = r"[a-f0-9]{12}"
BOARD_ID = r"\d{13}-[a-f0-9]{8}"
EMAIL_RE = re.compile(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$")

table = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
sns = boto3.client("sns")
# Regional endpoint + virtual addressing: avoids redirects that break browser uploads
s3 = boto3.client(
    "s3",
    region_name=REGION,
    endpoint_url=f"https://s3.{REGION}.amazonaws.com",
    config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}),
)


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


def reply(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type, x-teacher-key",
            "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        },
        "body": json.dumps(body, default=str) if body is not None else "",
    }


# ---------- helpers ----------

def is_teacher(event):
    given = (event.get("headers") or {}).get("x-teacher-key", "")
    return hmac.compare_digest(hashlib.sha256(given.encode()).hexdigest(), KEY_HASH)


def parse_body(event):
    if not event.get("body"):
        return {}
    try:
        data = json.loads(event["body"])
    except ValueError:
        raise ApiError(400, "The request was not valid JSON.")
    if not isinstance(data, dict):
        raise ApiError(400, "The request was not valid JSON.")
    return data


def query(pk, prefix=None, newest_first=False, limit=None, **extra):
    """All items for a partition (optionally a sort-key prefix), following pages."""
    condition = Key("pk").eq(pk)
    if prefix:
        condition &= Key("sk").begins_with(prefix)
    kwargs = {"KeyConditionExpression": condition, "ScanIndexForward": not newest_first, **extra}
    items = []
    while True:
        page = table.query(**kwargs)
        items += page["Items"]
        if limit and len(items) >= limit:
            return items[:limit]
        if "LastEvaluatedKey" not in page:
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def get_class(class_id):
    item = table.get_item(Key={"pk": "CLASSES", "sk": class_id}).get("Item")
    if not item:
        raise ApiError(404, "Class not found")
    return item


def remaining_today():
    day = time.strftime("%Y-%m-%d", time.gmtime())
    item = table.get_item(Key={"pk": "USAGE", "sk": day}).get("Item")
    return max(0, DAILY_LIMIT - int(item["uses"])) if item else DAILY_LIMIT


def subscriptions(topic_arn):
    """email -> subscription ARN ('PendingConfirmation' until the student confirms)."""
    found = {}
    pages = sns.get_paginator("list_subscriptions_by_topic").paginate(TopicArn=topic_arn)
    for page in pages:
        for sub in page["Subscriptions"]:
            found[sub["Endpoint"].lower()] = sub["SubscriptionArn"]
    return found


# ---------- router ----------

ROUTES = []


def route(method, pattern, teacher=True):
    regex = re.compile(f"^{pattern}$")

    def register(fn):
        ROUTES.append((method, regex, teacher, fn))
        return fn

    return register


# ----- classes -----

@route("GET", "/classes")
def list_classes(body):
    return [{"classId": c["sk"], "name": c["name"]} for c in query("CLASSES")]


@route("POST", "/classes")
def create_class(body):
    name = str(body.get("name", "")).strip()
    if not 1 <= len(name) <= 80:
        raise ApiError(400, "Class name must be 1 to 80 characters.")
    if len(query("CLASSES")) >= MAX_CLASSES:
        raise ApiError(400, f"You can have at most {MAX_CLASSES} classes.")
    class_id = uuid.uuid4().hex[:12]
    topic = sns.create_topic(Name=f"snap-class-{class_id}")["TopicArn"]
    table.put_item(Item={"pk": "CLASSES", "sk": class_id, "name": name, "topicArn": topic})
    return {"classId": class_id}


@route("GET", rf"/classes/(?P<cid>{ID})", teacher=False)
def class_info(body, cid):
    return {"classId": cid, "name": get_class(cid)["name"]}


# ----- students -----

@route("GET", rf"/classes/(?P<cid>{ID})/students")
def list_students(body, cid):
    subs = subscriptions(get_class(cid)["topicArn"])
    rows = []
    for item in query(cid, "S#"):
        arn = subs.get(item["email"], "")
        if arn.startswith("arn:"):
            status = "confirmed"
        elif arn == "PendingConfirmation":
            status = "pending"
        else:
            status = "inactive"      # never confirmed in time, or unsubscribed
        rows.append({"email": item["email"], "status": status})
    return rows


@route("POST", rf"/classes/(?P<cid>{ID})/students")
def add_students(body, cid):
    topic = get_class(cid)["topicArn"]
    raw = body.get("emails")
    if not isinstance(raw, list):
        raise ApiError(400, "emails must be a list.")
    emails = list(dict.fromkeys(str(e).strip().lower() for e in raw if str(e).strip()))
    if len(emails) > MAX_EMAILS_PER_REQUEST:
        raise ApiError(400, f"Add at most {MAX_EMAILS_PER_REQUEST} emails per request.")
    if len(query(cid, "S#")) + len(emails) > MAX_STUDENTS:
        raise ApiError(400, f"A class can have at most {MAX_STUDENTS} students.")

    added, invalid, failed = [], [], []
    for email in emails:
        if len(email) > 254 or not EMAIL_RE.match(email):
            invalid.append(email)
            continue
        try:
            sns.subscribe(TopicArn=topic, Protocol="email", Endpoint=email)
            table.put_item(Item={"pk": cid, "sk": f"S#{email}", "email": email})
            added.append(email)
        except ClientError:
            traceback.print_exc()
            failed.append(email)
    return {"added": added, "invalid": invalid, "failed": failed}


@route("DELETE", rf"/classes/(?P<cid>{ID})/students/(?P<email>[^/]+)")
def remove_student(body, cid, email):
    topic = get_class(cid)["topicArn"]
    email = unquote(email).lower()
    arn = subscriptions(topic).get(email, "")
    if arn.startswith("arn:"):       # pending subscriptions cannot be cancelled; they expire
        sns.unsubscribe(SubscriptionArn=arn)
    table.delete_item(Key={"pk": cid, "sk": f"S#{email}"})
    return {"removed": email}


# ----- boards -----

@route("POST", rf"/classes/(?P<cid>{ID})/upload")
def create_upload(body, cid):
    get_class(cid)
    left = remaining_today()
    if left <= 0:
        raise ApiError(429, "Daily photo limit reached. It resets at 05:30 IST.")
    board_id = f"{int(time.time() * 1000):013d}-{uuid.uuid4().hex[:8]}"
    post = s3.generate_presigned_post(
        Bucket=BUCKET,
        Key=f"boards/{cid}/{board_id}.jpg",
        Fields={"Content-Type": "image/jpeg"},
        Conditions=[{"Content-Type": "image/jpeg"}, ["content-length-range", 1, MAX_IMAGE_BYTES]],
        ExpiresIn=300,
    )
    return {"id": board_id, "post": post, "remaining": left}


@route("GET", rf"/classes/(?P<cid>{ID})/boards")
def list_boards(body, cid):
    get_class(cid)
    rows = query(
        cid, "B#", newest_first=True, limit=30,
        ProjectionExpression="sk, title, #s, #e, createdAt",
        ExpressionAttributeNames={"#s": "status", "#e": "error"},
    )
    boards = [
        {
            "id": r["sk"][2:],
            "title": r.get("title", ""),
            "status": r["status"],
            "error": r.get("error", ""),
            "createdAt": r["createdAt"],
        }
        for r in rows
    ]
    return {"boards": boards, "remaining": remaining_today()}


@route("DELETE", rf"/classes/(?P<cid>{ID})/boards/(?P<bid>{BOARD_ID})")
def delete_board(body, cid, bid):
    get_class(cid)
    table.delete_item(Key={"pk": cid, "sk": f"B#{bid}"})
    s3.delete_object(Bucket=BUCKET, Key=f"boards/{cid}/{bid}.jpg")
    return {"deleted": bid}


@route("GET", rf"/classes/(?P<cid>{ID})/notes", teacher=False)
def public_notes(body, cid):
    get_class(cid)
    rows = query(cid, "B#", newest_first=True, limit=40, FilterExpression=Attr("status").eq("ready"))
    return [
        {
            "id": r["sk"][2:],
            "title": r["title"],
            "notes": r["notes"],
            "createdAt": r["createdAt"],
            "imageUrl": s3.generate_presigned_url(
                "get_object", Params={"Bucket": BUCKET, "Key": r["imageKey"]}, ExpiresIn=3600
            ),
        }
        for r in rows
    ]


# ---------- entry point ----------

def handler(event, context):
    try:
        method = event["requestContext"]["http"]["method"]
        path = event["rawPath"].rstrip("/") or "/"

        if method == "OPTIONS":
            return reply(204, None)

        for route_method, regex, teacher_only, fn in ROUTES:
            match = regex.match(path)
            if route_method == method and match:
                if teacher_only and not is_teacher(event):
                    time.sleep(1)    # slows down passcode guessing
                    raise ApiError(401, "Wrong or missing teacher passcode.")
                return reply(200, fn(parse_body(event), **match.groupdict()))
        raise ApiError(404, "Not found")
    except ApiError as err:
        return reply(err.status, {"error": err.message})
    except Exception:
        traceback.print_exc()        # shows up in CloudWatch Logs
        return reply(500, {"error": "Something went wrong on the server. Try again."})
