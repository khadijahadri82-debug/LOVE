function initPrivateChat(root, initialAccessCode = "") {
  const accessRestrictedPanel = root.querySelector("#accessRestrictedPanel");
  const accessRestrictedMessage = root.querySelector("#accessRestrictedMessage");
  const loginForm = root.querySelector("#loginForm");
  const loginUsername = root.querySelector("#loginUsername");
  const loginPassword = root.querySelector("#loginPassword");
  const loginAccessCode = root.querySelector("#loginAccessCode");
  const loginError = root.querySelector("#loginError");
  const loginButton = root.querySelector("#loginButton");
  const conversationPanel = root.querySelector("#conversationPanel");
  const messageForm = root.querySelector("#messageForm");
  const messageInput = root.querySelector("#messageInput");
  const messageList = root.querySelector("#messageList");
  const messageArea = root.querySelector("#messageArea");
  const emptyMessages = root.querySelector("#emptyMessages");
  const historyButton = root.querySelector("#historyButton");
  const sendingStatus = root.querySelector("#sendingStatus");
  const sendError = root.querySelector("#sendError");
  const sendButton = root.querySelector("#sendButton");
  const pageError = root.querySelector("#pageError");
  const themeButton = root.querySelector("#themeButton");
  const controller = new AbortController();

  loginAccessCode.value = initialAccessCode;

  let csrfToken = "";
  let userId = null;
  let userName = "";
  let messageCursor = 0;
  let oldestMessageId = null;
  let hasMore = false;
  let isLoadingHistory = false;
  let pollTimer = null;
  let stopped = false;
  let disposed = false;

  function showError(element, message) {
    element.textContent = message;
    element.hidden = false;
  }

  function clearError(element) {
    element.textContent = "";
    element.hidden = true;
  }

  function isSessionError(error) {
    return error.message.includes("سجّل الدخول") || error.message.includes("انتهت صلاحية الجلسة");
  }

  function restrictAccess(message) {
    stopped = true;
    clearInterval(pollTimer);
    pollTimer = null;
    csrfToken = "";
    userId = null;
    userName = "";
    messageCursor = 0;
    oldestMessageId = null;
    hasMore = false;
    isLoadingHistory = false;
    messageList.replaceChildren();
    messageInput.value = "";
    sendingStatus.textContent = "";
    sendButton.disabled = false;
    historyButton.disabled = false;
    historyButton.textContent = "عرض الرسائل الأقدم";
    emptyMessages.hidden = true;
    historyButton.hidden = true;
    clearError(sendError);
    clearError(pageError);
    conversationPanel.hidden = true;
    accessRestrictedMessage.textContent = message;
    accessRestrictedPanel.hidden = false;
    loginButton.disabled = false;
  }

  async function request(url, options = {}) {
    const headers = { Accept: "application/json", ...options.headers };
    if (options.body) headers["Content-Type"] = "application/json";
    if (csrfToken && options.method && options.method !== "GET") headers["X-CSRF-Token"] = csrfToken;
    const response = await fetch(url, { credentials: "same-origin", ...options, headers, signal: controller.signal });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("تعذّر قراءة استجابة الخادم.");
    }
    if (!response.ok) throw new Error(window.getApiErrorMessage(result?.error, "تعذّر إكمال الطلب. حاول مرة أخرى."));
    return result;
  }

  function setTheme(theme) {
    root.dataset.theme = theme;
    localStorage.setItem("nasim-chat-theme", theme);
    themeButton.setAttribute("aria-label", theme === "dark" ? "التبديل إلى المظهر الفاتح" : "التبديل إلى المظهر الداكن");
  }

  function applyReadStatuses(statuses) {
    for (const status of statuses) {
      const receipt = messageList.querySelector(`[data-read-for="${status.id}"]`);
      if (receipt) receipt.textContent = status.isRead ? "مقروءة" : "تم الإرسال";
    }
  }

  function makeMessage(message) {
    const article = document.createElement("article");
    const ownMessage = message.senderId === userId;
    article.className = `message ${ownMessage ? "message-own" : "message-peer"}`;
    article.dataset.messageId = String(message.id);

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    const content = document.createElement("p");
    content.className = "message-content";
    content.textContent = message.body;
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const timestamp = document.createElement("time");
    timestamp.dateTime = message.createdAt;
    timestamp.textContent = new Intl.DateTimeFormat("ar", { hour: "2-digit", minute: "2-digit" }).format(new Date(message.createdAt));
    meta.append(timestamp);
    if (ownMessage) {
      const readStatus = document.createElement("span");
      readStatus.dataset.readFor = String(message.id);
      readStatus.textContent = message.isRead ? "مقروءة" : "تم الإرسال";
      meta.append(readStatus);
    }
    bubble.append(content, meta);
    article.append(bubble);
    return article;
  }

  function appendMessages(messages, { prepend = false } = {}) {
    const unique = messages.filter(message => !messageList.querySelector(`[data-message-id="${message.id}"]`));
    if (unique.length === 0) {
      emptyMessages.hidden = messageList.childElementCount > 0;
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const message of unique) fragment.append(makeMessage(message));
    if (prepend) {
      const previousHeight = messageArea.scrollHeight;
      messageList.prepend(fragment);
      messageArea.scrollTop += messageArea.scrollHeight - previousHeight;
    } else {
      messageList.append(fragment);
      messageArea.scrollTop = messageArea.scrollHeight;
    }
    emptyMessages.hidden = messageList.childElementCount > 0;
    if (messages.length) {
      messageCursor = Math.max(messageCursor, ...messages.map(message => message.id));
      oldestMessageId = oldestMessageId === null ? messages[0].id : Math.min(oldestMessageId, ...messages.map(message => message.id));
    }
  }

  async function loadMessages() {
    const result = await request("/api/messages");
    appendMessages(result.messages);
    hasMore = result.hasMore;
    historyButton.hidden = !hasMore;
    applyReadStatuses(result.readStatuses);
  }

  async function pollMessages() {
    if (stopped || !csrfToken) return;
    try {
      const result = await request(`/api/messages?after=${messageCursor}`);
      appendMessages(result.messages);
      applyReadStatuses(result.readStatuses);
    } catch (error) {
      if (disposed) return;
      if (isSessionError(error)) {
        restrictAccess("انتهت صلاحية الجلسة. يلزم وجود جلسة مشارك سارية لعرض الرسائل.");
      } else {
        showError(pageError, error.message);
      }
    }
  }

  async function showConversation(session) {
    userId = session.user.id;
    userName = session.user.displayName;
    csrfToken = session.csrfToken;
    root.querySelector("#peerName").textContent = session.peer.displayName;
    accessRestrictedPanel.hidden = true;
    conversationPanel.hidden = false;
    pageError.hidden = true;
    stopped = false;
    try {
      await loadMessages();
    } catch (error) {
      if (disposed || error.name === "AbortError") return;
      restrictAccess("تعذّر التحقق من صلاحية الجلسة. حدّث الصفحة لإعادة المحاولة.");
      return;
    }
    if (disposed) return;
    pollTimer = setInterval(pollMessages, 2500);
  }

  messageForm.addEventListener("submit", async event => {
    event.preventDefault();
    clearError(sendError);
    const body = messageInput.value.trim();
    if (!body) return;
    sendButton.disabled = true;
    sendingStatus.textContent = "جارٍ الإرسال...";
    try {
      const result = await request("/api/messages", { method: "POST", body: JSON.stringify({ body }) });
      messageInput.value = "";
      messageCursor = Math.max(messageCursor, result.id);
      appendMessages([{
        id: result.id,
        senderId: userId,
        senderName: userName,
        body,
        createdAt: result.createdAt,
        isRead: false
      }]);
      sendingStatus.textContent = "تم الإرسال";
      setTimeout(() => { sendingStatus.textContent = ""; }, 1800);
    } catch (error) {
      if (isSessionError(error)) {
        restrictAccess("انتهت صلاحية الجلسة. يلزم وجود جلسة مشارك سارية لعرض الرسائل.");
      } else {
        showError(sendError, error.message);
        sendingStatus.textContent = "";
      }
    } finally {
      sendButton.disabled = false;
    }
  });

  loginForm.addEventListener("submit", async event => {
    event.preventDefault();
    clearError(loginError);
    loginButton.disabled = true;
    try {
      await request("/api/login", {
        method: "POST",
        body: JSON.stringify({
          username: loginUsername.value,
          password: loginPassword.value,
          accessCode: loginAccessCode.value
        })
      });
      const session = await request("/api/session");
      if (!session.authenticated) throw new Error("تعذّر إنشاء الجلسة. تحقق من بيانات الدخول وحاول مجدداً.");
      await showConversation(session);
    } catch (error) {
      if (disposed || error.name === "AbortError") return;
      showError(loginError, window.getApiErrorMessage(error?.message, "تعذّر تسجيل الدخول. حاول مرة أخرى."));
    } finally {
      loginPassword.value = "";
      loginButton.disabled = false;
    }
  });

  historyButton.addEventListener("click", async () => {
    if (!hasMore || oldestMessageId === null || isLoadingHistory) return;
    isLoadingHistory = true;
    historyButton.disabled = true;
    historyButton.textContent = "جارٍ تحميل الرسائل...";
    try {
      const result = await request(`/api/messages?before=${oldestMessageId}`);
      appendMessages(result.messages, { prepend: true });
      hasMore = result.hasMore;
      historyButton.hidden = !hasMore;
    } catch (error) {
      if (isSessionError(error)) {
        restrictAccess("انتهت صلاحية الجلسة. يلزم وجود جلسة مشارك سارية لعرض الرسائل.");
      } else {
        showError(pageError, error.message);
      }
    } finally {
      isLoadingHistory = false;
      historyButton.disabled = false;
      historyButton.textContent = "عرض الرسائل الأقدم";
    }
  });

  root.querySelector("#logoutButton").addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await request("/api/logout", { method: "POST", body: "{}" });
    } catch (error) {
      if (isSessionError(error)) {
        restrictAccess("انتهت صلاحية الجلسة. يلزم وجود جلسة مشارك سارية لعرض الرسائل.");
      } else {
        showError(pageError, error.message);
        button.disabled = false;
      }
      return;
    }
    restrictAccess("تم تسجيل الخروج. يلزم وجود جلسة مشارك سارية لعرض الرسائل.");
  });

  themeButton.addEventListener("click", () => {
    setTheme(root.dataset.theme === "dark" ? "light" : "dark");
  });

  messageInput.addEventListener("input", () => {
    messageInput.style.height = "auto";
    messageInput.style.height = `${Math.min(messageInput.scrollHeight, 140)}px`;
  });

  setTheme(localStorage.getItem("nasim-chat-theme") || "light");

  request("/api/session")
    .then(session => {
      if (disposed) return;
      if (session.authenticated) return showConversation(session);
      restrictAccess("أدخل اسم المستخدم وكلمة المرور ورمز الوصول لتأكيد هويتك.");
    })
    .catch(error => {
      if (disposed || error.name === "AbortError") return;
      restrictAccess("تعذّر التحقق من صلاحية الجلسة. حدّث الصفحة لإعادة المحاولة.");
    });

  return function disposePrivateChat() {
    disposed = true;
    stopped = true;
    clearInterval(pollTimer);
    controller.abort();
  };
}

window.initPrivateChat = initPrivateChat;
