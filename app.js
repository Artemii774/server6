// ======================================================================
// НАСТРОЙКА: адрес вашего сервера.
// Бесплатные адреса *.trycloudflare.com меняются при каждом перезапуске
// cloudflared — если сайт "не подключается", сначала проверьте этот адрес.
// ======================================================================
const API = "https://proof-screens-atm-weights.trycloudflare.com";

const status = document.getElementById("status");
const userInfo = document.getElementById("userInfo");

const loginSection = document.getElementById("loginSection");
const loginForm = document.getElementById("loginForm");
const emailInput = document.getElementById("emailInput");
const usernameInput = document.getElementById("usernameInput");
const loginError = document.getElementById("loginError");

const cloudSection = document.getElementById("cloudSection");
const fileList = document.getElementById("fileList");
const uploadButton = document.getElementById("uploadButton");
const refreshButton = document.getElementById("refreshButton");
const folderButton = document.getElementById("folderButton");
const fileInput = document.getElementById("fileInput");
const logoutButton = document.getElementById("logoutButton");
const currentPath = document.getElementById("currentPath");
const userStorage = document.getElementById("userStorage");

let currentUser = null;
let currentFolder = "";


// ==============================
// Проверка сервера (не требует логина)
// ==============================

async function checkServer() {
    try {
        const response = await fetch(`${API}/`);
        if (!response.ok) throw new Error("Server error");
        status.textContent = "● Сервер онлайн";
        status.style.color = "#22c55e";
    } catch (error) {
        status.textContent = "● Сервер недоступен";
        status.style.color = "#ef4444";
    }
}


// ==============================
// ШАГ 1: ЛОГИН — отдельная процедура.
// При первом входе с этим Gmail сервер сам создаёт папку пользователя;
// при повторном входе просто открывает ту же папку.
// ==============================

async function checkLogin() {
    try {
        const response = await fetch(`${API}/auth/me`, { credentials: "include" });
        if (!response.ok) {
            showLogin();
            return;
        }
        currentUser = await response.json();
        enterCloud();
    } catch (error) {
        showLogin();
    }
}

loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.textContent = "";

    const email = emailInput.value.trim();
    const username = usernameInput.value.trim();
    if (!email) return;

    try {
        const response = await fetch(`${API}/auth/login`, {
            method: "POST",
            credentials: "include",   // без этого кука сессии не сохранится между доменами
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, username })
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || "Сервер отклонил вход");
        }

        currentUser = await response.json();
        enterCloud();   // подключение к файлам начинается только теперь

    } catch (error) {
        if (error instanceof TypeError) {
            loginError.textContent = "Не удалось связаться с сервером. Проверьте, что он запущен и адрес API верный.";
        } else {
            loginError.textContent = "Ошибка входа: " + error.message;
        }
    }
});

function showLogin() {
    loginSection.classList.remove("hidden");
    cloudSection.classList.add("hidden");
    userInfo.textContent = "Не выполнен вход";
}

function enterCloud() {
    loginSection.classList.add("hidden");
    cloudSection.classList.remove("hidden");
    userInfo.textContent = currentUser
        ? `${currentUser.username || currentUser.email} (${currentUser.email})`
        : "";
    currentFolder = "";
    loadFiles();   // ШАГ 2 начинается только здесь
}

logoutButton.addEventListener("click", async () => {
    try {
        await fetch(`${API}/auth/logout`, { method: "POST", credentials: "include" });
    } finally {
        currentUser = null;
        currentFolder = "";
        showLogin();
    }
});


// ==============================
// ШАГ 2: ФАЙЛЫ — вызывается только из enterCloud() и при навигации,
// то есть только когда логин уже подтверждён.
// ==============================

async function loadFiles() {
    fileList.innerHTML = `<div class="loading">Загрузка файлов...</div>`;
    try {
        const url = `${API}/files?folder=${encodeURIComponent(currentFolder)}`;
        const response = await fetch(url, { credentials: "include" });

        if (response.status === 401) {
            showLogin();  // сессия истекла — назад к логину, а не "ошибка сервера"
            return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        const files = Array.isArray(data) ? data : [];
        renderFiles(files);
        updateUserStorage(files);

        currentPath.textContent = currentFolder ? `Мои файлы / ${currentFolder}` : "Мои файлы";
    } catch (error) {
        fileList.innerHTML = `<div class="error">❌ Не удалось получить список файлов</div>`;
    }
}

function renderFiles(files) {
    fileList.innerHTML = "";
    if (files.length === 0) {
        fileList.innerHTML = `<div class="empty">📂 Папка пуста</div>`;
        return;
    }

    files.forEach(file => {
        const element = document.createElement("div");
        element.className = "file";
        const icon = getFileIcon(file.name, file.type);
        const size = formatBytes(file.size);

        // encodeURIComponent здесь — только чтобы безопасно вставить путь
        // в HTML-атрибут. Обработчики ниже декодируют его перед повторным
        // использованием, чтобы не закодировать дважды.
        const encodedPath = encodeURIComponent(file.path);

        element.innerHTML = `
            <div class="file-info">
                <div class="file-icon">${icon}</div>
                <div>
                    <div class="file-name">${escapeHtml(file.name)}</div>
                    <div class="file-size">${file.type === "directory" ? "Папка" : size}</div>
                </div>
            </div>
            <div class="file-actions">
                ${file.type === "file" ? `
                    <button class="download" onclick="downloadFile('${encodedPath}')">⬇️</button>
                    <button class="more" onclick="fileInfo('${encodedPath}')">ℹ️</button>
                ` : `
                    <button onclick="openFolder('${encodedPath}')">📂 Открыть</button>
                `}
                <button class="delete" onclick="deleteFile('${encodedPath}')">🗑️</button>
            </div>
        `;
        fileList.appendChild(element);
    });
}

function openFolder(encodedPath) {
    currentFolder = decodeURIComponent(encodedPath);
    loadFiles();
}

folderButton.addEventListener("click", async () => {
    const name = prompt("Введите название новой папки:");
    if (!name) return;

    try {
        const response = await fetch(`${API}/folders`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: name, folder: currentFolder })
        });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || "Не удалось создать папку.");
        }
        await loadFiles();
    } catch (error) {
        alert(error.message || "Не удалось создать папку.");
    }
});

function downloadFile(encodedPath) {
    const path = decodeURIComponent(encodedPath);
    window.open(`${API}/download?path=${encodeURIComponent(path)}`, "_blank");
}

async function deleteFile(encodedPath) {
    const path = decodeURIComponent(encodedPath);
    if (!confirm("Удалить файл?")) return;
    try {
        await fetch(`${API}/files?path=${encodeURIComponent(path)}`, {
            method: "DELETE",
            credentials: "include"
        });
        await loadFiles();
    } catch (error) {
        alert("Не удалось удалить файл.");
    }
}

async function fileInfo(encodedPath) {
    const path = decodeURIComponent(encodedPath);
    try {
        const response = await fetch(`${API}/file-info?path=${encodeURIComponent(path)}`, { credentials: "include" });
        const data = await response.json();
        alert(`Файл: ${data.name}\nРазмер: ${formatBytes(data.size)}\nИзменён: ${data.modified}`);
    } catch (error) {
        alert("Не удалось получить информацию.");
    }
}

uploadButton.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);
    formData.append("folder", currentFolder);

    uploadButton.disabled = true;
    uploadButton.textContent = "⏳ Загрузка...";
    try {
        const response = await fetch(`${API}/upload`, {
            method: "POST",
            credentials: "include",
            body: formData
        });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || "Ошибка загрузки.");
        }
        fileInput.value = "";
        await loadFiles();
    } catch (error) {
        alert(error.message || "Ошибка загрузки.");
    } finally {
        uploadButton.disabled = false;
        uploadButton.textContent = "⬆ Загрузить файл";
    }
});

refreshButton.addEventListener("click", loadFiles);

function updateUserStorage(files) {
    let total = 0;
    files.forEach(file => { if (file.type === "file") total += Number(file.size) || 0; });
    userStorage.textContent = formatBytes(total);
}

function getFileIcon(name, type) {
    if (type === "directory") return "📁";
    const extension = name.split(".").pop().toLowerCase();

    if (["jpg", "jpeg", "png", "gif", "webp", "heic"].includes(extension)) return "🖼️";
    if (["mp4", "mov", "avi", "mkv"].includes(extension)) return "🎬";
    if (["mp3", "wav", "flac", "ogg"].includes(extension)) return "🎵";
    if (["zip", "rar", "7z", "tar", "gz"].includes(extension)) return "📦";
    if (extension === "pdf") return "📕";
    if (["doc", "docx"].includes(extension)) return "📘";
    if (["xls", "xlsx"].includes(extension)) return "📊";
    if (["js", "java", "py", "cpp", "c", "html", "css"].includes(extension)) return "💻";

    return "📄";
}


// ==============================
// АДМИН-ПАНЕЛЬ
// ==============================

const adminLink = document.getElementById("adminLink");
const adminModal = document.getElementById("adminModal");
const closeAdmin = document.getElementById("closeAdmin");
const adminPassword = document.getElementById("adminPassword");
const adminLoginButton = document.getElementById("adminLoginButton");
const adminLogin = document.getElementById("adminLogin");
const adminPanel = document.getElementById("adminPanel");
const adminError = document.getElementById("adminError");

adminLink.addEventListener("click", () => {
    adminModal.classList.remove("hidden");
    adminLogin.classList.remove("hidden");
    adminPanel.classList.add("hidden");
    adminPassword.value = "";
    adminError.textContent = "";
});

closeAdmin.addEventListener("click", () => adminModal.classList.add("hidden"));
adminLoginButton.addEventListener("click", adminLoginRequest);

async function adminLoginRequest() {
    const password = adminPassword.value;
    if (!password) return;
    try {
        const response = await fetch(`${API}/admin/login`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password })
        });
        if (!response.ok) {
            adminError.textContent = "❌ Неверный пароль";
            return;
        }
        adminLogin.classList.add("hidden");
        adminPanel.classList.remove("hidden");

        const statsRes = await fetch(`${API}/admin/stats`, { credentials: "include" });
        const data = await statsRes.json();
        document.getElementById("adminUsers").textContent = data.users;
        document.getElementById("adminUsed").textContent = formatBytes(data.used);
        document.getElementById("adminFree").textContent = formatBytes(data.free);
        document.getElementById("adminTotal").textContent = formatBytes(data.total);

        const list = document.getElementById("adminUserList");
        list.innerHTML = "";
        data.user_emails.forEach(email => {
            const div = document.createElement("div");
            div.className = "admin-user";
            div.textContent = email;
            list.appendChild(div);
        });
    } catch (error) {
        adminError.textContent = "Ошибка подключения.";
    }
}


// ==============================
// Вспомогательные функции
// ==============================

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2) + " " + units[i];
}


// ==============================
// Запуск: проверяем сервер и логин.
// Файлы загружаются только внутри enterCloud().
// ==============================

checkServer();
checkLogin();
