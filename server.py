import os
import re
import secrets
import shutil
from pathlib import Path
from datetime import datetime
from flask import Flask, request, jsonify, send_file, session
from flask_cors import CORS

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", secrets.token_hex(32))

# --- Cross-origin session cookies -------------------------------------
# Frontend (GitHub Pages) and this API live on different domains, so the
# cookie must explicitly allow that.
app.config.update(
    SESSION_COOKIE_SAMESITE="None",
    SESSION_COOKIE_SECURE=True,      # requires HTTPS (the cloudflare tunnel provides this)
    SESSION_COOKIE_HTTPONLY=True,
)

# --- CORS ---------------------------------------------------------------
# Add every domain your frontend is actually served from.
ALLOWED_ORIGINS = [
    "https://artemii774.github.io",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
]
CORS(app, supports_credentials=True, origins=ALLOWED_ORIGINS)

STORAGE_ROOT = Path("/mnt/ssd/server-files")
USERS_ROOT = STORAGE_ROOT / "users"      # one folder per Gmail address
META_ROOT = STORAGE_ROOT / "meta"        # bookkeeping, kept out of user's visible storage
TOTAL_STORAGE = 500 * 1024 ** 3

USERS_ROOT.mkdir(parents=True, exist_ok=True)
META_ROOT.mkdir(parents=True, exist_ok=True)

ADMIN_PASSWORD = os.environ.get("CLOUD_ADMIN_PASSWORD")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def safe_user_directory(user_id):
    """Returns (and creates on first use) the folder that belongs to this
    Gmail address, e.g. /mnt/ssd/server-files/users/someone@gmail.com/"""
    directory = (USERS_ROOT / user_id).resolve()
    root = USERS_ROOT.resolve()
    if directory != root and root not in directory.parents:
        raise ValueError("Invalid user directory")
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def safe_user_path(user_id, relative_path=""):
    user_root = safe_user_directory(user_id)
    target = (user_root / relative_path).resolve()
    if target != user_root and user_root not in target.parents:
        raise ValueError("Path traversal blocked")
    return target


def require_user():
    return session.get("user_id")


def require_admin():
    return session.get("admin") is True


@app.route("/")
def index():
    return jsonify({"server": "Raspberry Pi File API", "status": "online"})


@app.route("/auth/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    email = data.get("email", "").strip().lower()
    username = data.get("username", "").strip()

    if not email or not EMAIL_RE.match(email):
        return jsonify({"error": "Valid email required"}), 400

    if not username:
        username = email.split("@")[0]

    session["user_id"] = email
    session["email"] = email
    session["username"] = username
    session.permanent = True

    is_new_user = not (META_ROOT / f"{email}.email").exists()

    # This is the "registration" step: the user's storage folder is
    # created here, named after their Gmail address, the first time
    # they ever log in. Every later login just reuses the same folder.
    safe_user_directory(email)
    (META_ROOT / f"{email}.email").write_text(email, encoding="utf-8")

    return jsonify({
        "status": "logged_in",
        "email": email,
        "username": username,
        "new_user": is_new_user
    })


@app.route("/auth/me")
def auth_me():
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"authenticated": False}), 401

    return jsonify({
        "authenticated": True,
        "email": session.get("email"),
        "username": session.get("username", user_id)
    })


@app.route("/auth/logout", methods=["POST"])
def auth_logout():
    session.clear()
    return jsonify({"status": "logged_out"})


@app.route("/files")
def list_files():
    user_id = require_user()
    if not user_id:
        return jsonify({"error": "Authentication required"}), 401

    requested_folder = request.args.get("folder", "")
    try:
        directory = safe_user_path(user_id, requested_folder)
    except ValueError:
        return jsonify({"error": "Invalid path"}), 403

    if not directory.exists():
        return jsonify([])

    result = []
    for item in directory.iterdir():
        if item.name.startswith("."):
            continue  # never list hidden/bookkeeping files
        try:
            relative = item.relative_to(safe_user_directory(user_id))
        except ValueError:
            continue

        if item.is_dir():
            result.append({"name": item.name, "path": str(relative), "size": 0, "type": "directory"})
        elif item.is_file():
            result.append({"name": item.name, "path": str(relative), "size": item.stat().st_size, "type": "file"})

    return jsonify(result)


@app.route("/upload", methods=["POST"])
def upload():
    user_id = require_user()
    if not user_id:
        return jsonify({"error": "Authentication required"}), 401

    uploaded_file = request.files.get("file")
    if not uploaded_file or not uploaded_file.filename:
        return jsonify({"error": "No file"}), 400

    folder = request.form.get("folder", "")
    filename = Path(uploaded_file.filename).name  # strip any path components

    try:
        directory = safe_user_path(user_id, folder)
        directory.mkdir(parents=True, exist_ok=True)
        target = safe_user_path(user_id, str(Path(folder) / filename))
    except ValueError:
        return jsonify({"error": "Invalid path"}), 403

    # Basic quota check so one user can't fill the whole 500 GB disk.
    used = sum(f.stat().st_size for f in safe_user_directory(user_id).rglob("*") if f.is_file())
    incoming_size = request.content_length or 0
    if used + incoming_size > TOTAL_STORAGE:
        return jsonify({"error": "Storage limit reached"}), 507

    uploaded_file.save(target)
    return jsonify({"status": "uploaded", "name": filename})


@app.route("/download")
def download():
    user_id = require_user()
    if not user_id:
        return jsonify({"error": "Authentication required"}), 401

    relative_path = request.args.get("path", "")
    try:
        target = safe_user_path(user_id, relative_path)
    except ValueError:
        return jsonify({"error": "Invalid path"}), 403

    if not target.is_file():
        return jsonify({"error": "File not found"}), 404

    return send_file(target, as_attachment=True)


@app.route("/files", methods=["DELETE"])
def delete_file():
    user_id = require_user()
    if not user_id:
        return jsonify({"error": "Authentication required"}), 401

    relative_path = request.args.get("path", "")
    try:
        target = safe_user_path(user_id, relative_path)
    except ValueError:
        return jsonify({"error": "Invalid path"}), 403

    if not target.exists():
        return jsonify({"error": "Not found"}), 404

    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()

    return jsonify({"status": "deleted"})


@app.route("/folders", methods=["POST"])
def create_folder():
    user_id = require_user()
    if not user_id:
        return jsonify({"error": "Authentication required"}), 401

    data = request.get_json(silent=True) or {}
    name = data.get("name", "").strip()
    folder = data.get("folder", "")

    if not name or "/" in name or "\\" in name or name in (".", ".."):
        return jsonify({"error": "Invalid folder name"}), 400

    try:
        target = safe_user_path(user_id, str(Path(folder) / name))
        target.mkdir(parents=False, exist_ok=False)
    except FileExistsError:
        return jsonify({"error": "Folder already exists"}), 409
    except (ValueError, FileNotFoundError):
        return jsonify({"error": "Invalid path"}), 403

    return jsonify({"status": "created"})


@app.route("/file-info")
def file_info():
    user_id = require_user()
    if not user_id:
        return jsonify({"error": "Authentication required"}), 401

    relative_path = request.args.get("path", "")
    try:
        target = safe_user_path(user_id, relative_path)
    except ValueError:
        return jsonify({"error": "Invalid path"}), 403

    if not target.exists():
        return jsonify({"error": "Not found"}), 404

    stat = target.stat()
    return jsonify({
        "name": target.name,
        "size": stat.st_size,
        "type": "directory" if target.is_dir() else "file",
        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat()
    })


@app.route("/admin/login", methods=["POST"])
def admin_login():
    if not ADMIN_PASSWORD:
        return jsonify({"error": "Admin password is not configured"}), 500

    data = request.get_json(silent=True) or {}
    password = data.get("password", "")

    if not secrets.compare_digest(password, ADMIN_PASSWORD):
        return jsonify({"error": "Invalid password"}), 401

    session["admin"] = True
    return jsonify({"status": "authenticated"})


@app.route("/admin/stats")
def admin_stats():
    if not require_admin():
        return jsonify({"error": "Admin authentication required"}), 403

    total_used = 0
    for user_directory in USERS_ROOT.iterdir():
        if not user_directory.is_dir():
            continue
        for file in user_directory.rglob("*"):
            if file.is_file() and not file.name.startswith("."):
                try:
                    total_used += file.stat().st_size
                except OSError:
                    pass

    user_emails = sorted(p.stem for p in META_ROOT.glob("*.email"))

    free = max(0, TOTAL_STORAGE - total_used)
    return jsonify({
        "users": len(user_emails),
        "used": total_used,
        "free": free,
        "total": TOTAL_STORAGE,
        "user_emails": user_emails
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
