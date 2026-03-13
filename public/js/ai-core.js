import { FilesetResolver, FaceLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/vision_bundle.js";

// 全域變數定義
let socket, faceLandmarker, objectDetector, videoElement, localStream = null;
let myStatus = "FOCUSED", distractionStartTime = 0, lastObjectCheckTime = 0;
let isPhoneDetected = false, lastFaceCheckTime = 0, currentRoomMode = "1";
let sessionStartTime = null; 
let lastVideoTime = -1;
let myUsername = localStorage.getItem('studyVerseUser') || "學員"; 

// --- [新增/修正] 模擬教室與教師功能變數 ---
let isPauseMode = false;      
let pauseEndTime = 0;         
let lastViolationTime = 0;    
let remoteUsers = [];

// --- 介面更新邏輯 ---
function updateUIMode(mode) {
    const modeLabel = document.getElementById("modeLabel");
    const blackboard = document.getElementById("blackboard");
    const breakButtons = document.getElementById("breakButtons");

    if (!modeLabel) return;
    
    switch(mode) {
        case '2':
            modeLabel.innerText = "MODE: 沉浸式自習 (嚴格)";
            modeLabel.className = "text-[10px] font-black text-purple-500 tracking-tighter";
            if(blackboard) blackboard.classList.add('hidden');
            if(breakButtons) breakButtons.classList.add('hidden');
            break;
        case 'simulated':
            modeLabel.innerText = "MODE: 模擬線上教室 (連動中)";
            modeLabel.className = "text-[10px] font-black text-blue-500 tracking-tighter";
            if(blackboard) blackboard.classList.remove('hidden');
            if(breakButtons) breakButtons.classList.remove('hidden');
            break;
        case '1':
            modeLabel.innerText = "MODE: 線上課程 (寬鬆)";
            modeLabel.className = "text-[10px] font-black text-cyan-500 tracking-tighter";
            if(blackboard) blackboard.classList.add('hidden');
            if(breakButtons) breakButtons.classList.add('hidden');
            break;
        default:
            modeLabel.innerText = "MODE: 一般自習";
    }
}

// 初始化 Socket
if (typeof io !== 'undefined') {
    socket = io();
    
    socket.on("update_rank", (users) => {
        remoteUsers = users; 
        
        // 1. 更新左側排行榜
        const rankContainer = document.getElementById("tab-rank");
        if (rankContainer) {
            const sortedUsers = [...users].sort((a, b) => (b.score || 0) - (a.score || 0));
            rankContainer.innerHTML = sortedUsers.map((u, index) => `
                <div class="flex items-center gap-3 p-3 bg-white/5 rounded-xl border border-white/5 mb-2 transition-all">
                    <span class="font-mono font-bold ${index < 3 ? 'text-yellow-500' : 'text-gray-500'}">#${index + 1}</span>
                    <img src="https://api.dicebear.com/7.x/big-smile/svg?seed=${u.name}" class="w-8 h-8 rounded-full border border-gray-700">
                    <div class="flex-1 min-w-0">
                        <p class="text-xs font-bold text-white truncate">${u.name}</p>
                        <p class="text-[10px] text-blue-400 truncate">${u.status === 'BREAK' ? '🚽 暫時離開' : (u.goal || '專注中')}</p>
                    </div>
                    <div class="text-right">
                        <p class="text-xs font-mono text-gray-300">${u.focusMinutes || 0} min</p>
                        <div class="w-1.5 h-1.5 rounded-full ${u.status === 'FOCUSED' ? 'bg-green-500 shadow-[0_0_5px_#22c55e]' : (u.status === 'BREAK' ? 'bg-blue-500' : 'bg-red-500 shadow-[0_0_5px_#ef4444]')} ml-auto mt-1"></div>
                    </div>
                </div>
            `).join('');
        }

        // 2. 更新主畫面中央網格
        const othersContainer = document.getElementById("othersContainer");
        if (othersContainer) {
            const others = users.filter(u => u.name !== myUsername);
            othersContainer.innerHTML = others.map(u => `
                <div class="flex flex-col group animate-fade-in">
                    <div class="relative aspect-video bg-gray-900 rounded-3xl overflow-hidden border-2 ${u.status === 'FOCUSED' ? 'border-white/10' : (u.status === 'BREAK' ? 'border-blue-500/50' : 'border-red-500/50')} transition-all duration-500">
                        <span class="status-badge ${u.status === 'BREAK' ? 'bg-blue-600' : ''}">${u.status}</span>
                        
                        ${u.isFlipped ? '<span class="absolute top-2 right-2 bg-blue-600 text-[8px] px-2 py-1 rounded-full text-white z-10 animate-pulse"><i class="fas fa-mobile-alt mr-1"></i>已翻轉</span>' : ''}

                        <div class="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-transparent to-black/60">
                            <img src="https://api.dicebear.com/7.x/big-smile/svg?seed=${u.name}" 
                                 class="w-20 h-20 rounded-full mb-3 border-4 ${u.status === 'FOCUSED' ? 'border-green-500' : (u.status === 'BREAK' ? 'border-blue-500' : 'border-red-500')} shadow-2xl transition-transform group-hover:scale-110">
                            <p class="text-white font-bold text-sm">${u.name}</p>
                        </div>

                        <div class="absolute inset-0 bg-red-950/40 backdrop-blur-[2px] flex items-center justify-center transition-opacity ${u.status === 'DISTRACTED' || u.status === 'SLEEPING' ? 'opacity-100' : 'opacity-0'} pointer-events-none">
                            <i class="fas fa-exclamation-triangle text-red-500 text-2xl animate-pulse"></i>
                        </div>
                        
                        ${u.status === 'BREAK' ? '<div class="absolute inset-0 bg-blue-900/20 backdrop-blur-sm flex items-center justify-center"><p class="text-white text-[10px] font-bold">生理需求暫離中</p></div>' : ''}
                    </div>
                </div>
            `).join('');
        }
    });

    socket.on("receive_reaction", (data) => {
        showFloatingEmoji(data.emoji);
    });

    // --- 接收教師指令 ---
    socket.on("admin_action", (data) => {
        if (data.type === 'WAKEUP' && data.target === myUsername) {
            const audio = new Audio('https://actions.google.com/sounds/v1/alarms/beep_short.ogg');
            audio.play().catch(e => console.log("音效播放受阻"));
            
            const overlay = document.getElementById("distractionOverlay");
            overlay.style.backgroundColor = "rgba(239, 68, 68, 0.7)";
            overlay.style.opacity = 1;
            document.getElementById("overlayText").innerHTML = `<i class="fas fa-bolt text-5xl mb-4 text-yellow-400"></i><br>老師正在關注你！<br><span class="text-lg">請立刻回到專注狀態</span>`;
            
            document.body.classList.add('animate-pulse');
            setTimeout(() => {
                document.body.classList.remove('animate-pulse');
                if (myStatus === 'FOCUSED') overlay.style.opacity = 0;
            }, 5000);
        }
        
        if (data.type === 'BLACKBOARD') {
            const bbContent = document.getElementById('blackboardContent'); 
            if (bbContent) {
                bbContent.innerText = data.content;
                bbContent.classList.add('text-yellow-400');
                setTimeout(() => bbContent.classList.remove('text-yellow-400'), 2000);
            }
        }
        
        if (data.type === 'PLAY_SOUND' && data.sound === 'chime') {
            const bell = new Audio('https://actions.google.com/sounds/v1/alarms/mechanical_clock_ring.ogg');
            bell.play().catch(e => {});
        }
    });
}

// --- [修正] 生理需求處理 ---
window.requestBreak = function(type) {
    if (isPauseMode) return;
    const minutes = (type === 'toilet') ? 5 : 2;
    isPauseMode = true;
    pauseEndTime = Date.now() + minutes * 60000;
    
    myStatus = "BREAK";
    socket.emit("update_status", { status: "BREAK", reason: type, name: myUsername });

    const overlay = document.getElementById("distractionOverlay");
    const overlayText = document.getElementById("overlayText");
    
    overlay.style.opacity = 1;
    overlay.style.backgroundColor = "rgba(10, 20, 50, 0.9)";
    
    // 清除舊的計時器（如果有的話）並啟動新的
    if (window.breakCountdown) clearInterval(window.breakCountdown);
    window.breakCountdown = setInterval(() => {
        const remaining = Math.ceil((pauseEndTime - Date.now()) / 1000);
        if (remaining <= 0 || !isPauseMode) {
            clearInterval(window.breakCountdown);
            if (isPauseMode) endBreak();
        } else {
            const m = Math.floor(remaining / 60);
            const s = remaining % 60;
            overlayText.innerHTML = `
                <span class="text-blue-400 text-4xl mb-2">${type === 'toilet' ? '🚽' : '💧'}</span><br>
                <span class="text-xl font-bold">生理需求中...</span><br>
                <span class="text-sm text-gray-300">剩餘時間: ${m}:${s.toString().padStart(2,'0')}</span><br>
                <button onclick="endBreak()" class="mt-6 px-6 py-2 bg-blue-600 rounded-full text-xs font-bold shadow-lg">我回來了</button>`;
        }
    }, 1000);
};

window.endBreak = function() {
    isPauseMode = false;
    myStatus = "FOCUSED";
    if (window.breakCountdown) clearInterval(window.breakCountdown);
    const overlay = document.getElementById("distractionOverlay");
    overlay.style.opacity = 0;
    overlay.style.backgroundColor = "rgba(0,0,0,0.8)";
    socket.emit("update_status", { status: "FOCUSED", name: myUsername });
};

// --- 教師截圖上傳功能 ---
async function captureViolation(reason) {
    const now = Date.now();
    if (now - lastViolationTime < 15000) return; 
    lastViolationTime = now;

    const canvas = document.createElement('canvas');
    canvas.width = videoElement.videoWidth;
    canvas.height = videoElement.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoElement, 0, 0);
    const imageData = canvas.toDataURL('image/jpeg', 0.4); 

    socket.emit("report_violation", {
        name: myUsername,
        reason: reason,
        image: imageData,
        time: new Date().toLocaleTimeString()
    });
}

// --- [修正] 偵測分頁切換 ---
document.addEventListener("visibilitychange", () => {
    if (document.hidden && currentRoomMode === 'simulated' && !isPauseMode) {
        socket.emit("report_violation", {
            name: myUsername,
            reason: "🚫 切換分頁/離開視窗",
            image: null,
            time: new Date().toLocaleTimeString()
        });
    }
});

// 鏡頭初始預覽
document.addEventListener('DOMContentLoaded', async () => {
    const urlParams = new URLSearchParams(window.location.search);
    const mode = urlParams.get('mode');
    if (mode) {
        currentRoomMode = mode;
        updateUIMode(mode);
    }

    const inputName = document.getElementById('inputName');
    if (inputName && myUsername) inputName.value = myUsername;

    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
        const preview = document.getElementById('previewWebcam');
        if(preview) preview.srcObject = localStream;
        const statusEl = document.getElementById('previewStatus');
        if(statusEl) statusEl.innerText = "✅ 鏡頭已就緒";
    } catch (err) { 
        const statusEl = document.getElementById('previewStatus');
        if(statusEl) statusEl.innerText = "❌ 無法存取鏡頭";
    }
});

async function initApp() {
    const nameInput = document.getElementById('inputName');
    const name = nameInput?.value || "學員";
    const goal = document.getElementById('inputGoal')?.value || "專注學習";
    const minInput = document.getElementById('inputTime');
    const min = minInput ? parseInt(minInput.value) : 25;
    
    const modeInput = document.getElementById('inputMode');
    if (modeInput) currentRoomMode = modeInput.value;
    
    myUsername = name; 
    sessionStartTime = Date.now(); 

    document.getElementById("mySidebarName").innerText = name;
    document.getElementById("mySidebarGoal").innerText = goal;
    document.getElementById("dashboardGoal").innerText = goal;
    document.getElementById("mySidebarAvatar").src = `https://api.dicebear.com/7.x/big-smile/svg?seed=${name}`;
    updateUIMode(currentRoomMode);

    const endTime = Date.now() + min * 60000;
    const timerInterval = setInterval(() => {
        if (isPauseMode) return; 

        const diff = Math.ceil((endTime - Date.now()) / 1000);
        const timerDisplay = document.getElementById("myTimerDisplay");
        const progress = document.getElementById("timerProgress");
        
        if (diff <= 0) {
            clearInterval(timerInterval);
            alert("🎉 達成專注目標！");
            endSession(); 
        } else {
            const m = Math.floor(diff / 60).toString().padStart(2, '0');
            const s = (diff % 60).toString().padStart(2, '0');
            if(timerDisplay) timerDisplay.innerText = `${m}:${s}`;
            if(progress) progress.style.width = `${((min * 60 - diff) / (min * 60)) * 100}%`;
        }
    }, 1000);

    if(socket) socket.emit("join_room", { name, goal, planTime: min });
    await initAI();
}

async function initAI() {
    const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm");
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`, delegate: "CPU" },
        runningMode: "VIDEO", numFaces: 1
    });
    objectDetector = await cocoSsd.load();
    videoElement = document.getElementById("webcam");
    if (videoElement) {
        videoElement.srcObject = localStream;
        videoElement.onloadedmetadata = () => {
            document.getElementById('startOverlay').style.display = 'none';
            predictLoop();
        };
    }
}

// --- [修正] 違規判定邏輯 ---
async function predictLoop() {
    if (isPauseMode) { 
        requestAnimationFrame(predictLoop);
        return;
    }

    const now = performance.now();
    let currentIssue = null;
    
    if (videoElement && videoElement.readyState >= 2 && videoElement.currentTime !== lastVideoTime) {
        lastVideoTime = videoElement.currentTime;
        
        // 1. 手機偵測邏輯 (提高精準度)
        if (now - lastObjectCheckTime > 1000) { 
            lastObjectCheckTime = now;
            const predictions = await objectDetector.detect(videoElement);
            isPhoneDetected = predictions.some(p => p.class === 'cell phone' && p.score > 0.6);
        }

        const meInRoom = remoteUsers.find(u => u.name === myUsername);
        const isFlippedNow = meInRoom && meInRoom.isFlipped;
        
        // 如果偵測到手機且「未翻轉」，判定為違規
        if (isPhoneDetected && !isFlippedNow) {
            currentIssue = "📱 使用手機";
        } else if (now - lastFaceCheckTime > 800) { // 提高臉部偵測頻率
            lastFaceCheckTime = now;
            const results = faceLandmarker.detectForVideo(videoElement, now);
            
            if (!results.faceLandmarks || results.faceLandmarks.length === 0) {
                currentIssue = "🪑 偵測到離座";
            } else {
                const nose = results.faceLandmarks[0][1];
                // 優化趴睡判斷門檻
                if (nose.y > 0.75) {
                    currentIssue = (currentRoomMode === "1") ? "✍️ 抄筆記中..." : "💤 偵測到趴睡";
                }
            }
        }
    }
    
    handleDistractionBuffer(currentIssue, now);
    requestAnimationFrame(predictLoop);
}

function handleDistractionBuffer(issue, now) {
    const overlay = document.getElementById("distractionOverlay");
    const statusBubble = document.getElementById("myStatusBubble");
    const overlayText = document.getElementById("overlayText");

    let prevStatus = myStatus;

    if (issue === "✍️ 抄筆記中...") {
        distractionStartTime = 0;
        overlay.style.opacity = 0;
        myStatus = "FOCUSED";
    } else if (issue) {
        if (distractionStartTime === 0) distractionStartTime = now;
        const elapsed = (now - distractionStartTime) / 1000;
        let limit = (currentRoomMode === "2" || currentRoomMode === "simulated") ? 5 : 10;
        
        if (elapsed < limit) {
            overlay.style.opacity = 0.8;
            overlayText.innerHTML = `${issue}<br><span class="text-xs">警告: ${Math.ceil(limit - elapsed)}s</span>`;
            myStatus = "FOCUSED"; 
        } else {
            myStatus = (issue === "💤 偵測到趴睡") ? "SLEEPING" : "DISTRACTED";
            overlay.style.opacity = 1;
            overlayText.innerHTML = `❌ 違規中<br><span class="text-xs">${issue}</span>`;
            statusBubble.className = "w-2.5 h-2.5 rounded-full bg-red-500 shadow-[0_0_8px_#ef4444]";
            
            if (currentRoomMode === 'simulated') captureViolation(issue);
        }
    } else {
        myStatus = "FOCUSED";
        distractionStartTime = 0;
        overlay.style.opacity = 0;
        statusBubble.className = "w-2.5 h-2.5 rounded-full bg-green-500 shadow-[0_0_8px_#22c55e]";
    }
    
    if(socket && (prevStatus !== myStatus || Math.floor(now) % 3000 === 0)) {
        socket.emit("update_status", { status: myStatus, name: myUsername });
    }
}

// --- [修正] 結算與早退懲罰 ---
async function endSession() {
    const elapsedMinutes = Math.floor((Date.now() - sessionStartTime) / 60000);
    const minRequired = 20;

    // 早退警告與懲罰觸發
    if (elapsedMinutes < minRequired && currentRoomMode === 'simulated') {
        const confirmLeave = confirm(`⚠️ 專注未滿 ${minRequired} 分鐘！\n現在離開將會「加重扣分」並留下記錄。\n\n確定要早退嗎？`);
        if (!confirmLeave) return;
        
        socket.emit("early_leave", { 
            name: myUsername, 
            elapsed: elapsedMinutes,
            penalty: true 
        });
    }

    const durationSeconds = Math.floor((Date.now() - sessionStartTime) / 1000);
    try {
        await fetch('/api/save-focus', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: myUsername,
                roomType: currentRoomMode,
                focusSeconds: durationSeconds
            })
        });
    } catch (err) { console.error("存檔失敗:", err); }
    
    if(socket) socket.disconnect();
    window.location.href = 'index.html'; 
}

function showFloatingEmoji(emoji) {
    const el = document.createElement('div');
    el.className = 'floating-emoji fixed bottom-20 z-[60] pointer-events-none animate-bounce'; 
    el.style.left = `${Math.random() * 60 + 20}%`;
    el.innerHTML = `<span class="text-5xl drop-shadow-lg">${emoji}</span>`;
    document.body.appendChild(el); 
    setTimeout(() => el.remove(), 2000);
}

window.initApp = initApp;
window.endSession = endSession;
window.sendReaction = (emoji) => {
    showFloatingEmoji(emoji);
    if(socket) socket.emit("send_reaction", { emoji, username: myUsername });
};

setInterval(() => {
    const now = new Date();
    const clockTime = document.getElementById('clockTime');
    if(clockTime) clockTime.innerText = now.toLocaleTimeString('zh-TW', { hour12: false });
}, 1000);