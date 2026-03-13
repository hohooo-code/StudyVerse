// 引入環境變數設定 (必須放在最頂端)
require('dotenv').config();

const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 提高 JSON 限制以接收 Base64 截圖
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. 連線 Supabase 雲端資料庫 (改為從 .env 讀取)
// ==========================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ 錯誤：找不到 Supabase 設定，請檢查 .env 檔案！');
}

const supabase = createClient(supabaseUrl, supabaseKey);
console.log('✅ 已成功載入 Supabase 雲端資料庫設定。');

// ==========================================
// 2. API 路由設定
// ==========================================

app.get('/api/user-stats', async (req, res) => {
    const username = req.query.username;
    if (!username) return res.status(400).json({ error: '缺少使用者名稱' });

    try {
        const { data: user } = await supabase
            .from('users')
            .select('*')
            .eq('username', username)
            .single();

        const { data: records } = await supabase
            .from('focus_records')
            .select('*')
            .eq('username', username)
            .order('created_at', { ascending: false })
            .limit(10);

        res.json({
            user: user || { total_seconds: 0, streak: 1, role: 'student', integrity_score: 100 },
            records: records || []
        });
    } catch (err) {
        console.error("API 錯誤:", err);
        res.status(500).json({ error: '資料庫讀取錯誤' });
    }
});

app.post('/api/save-focus', async (req, res) => {
    const { username, roomType, focusSeconds } = req.body;
    if (!username || !roomType || focusSeconds === undefined) {
        return res.status(400).json({ error: '缺少參數' });
    }

    const today = new Date().toISOString().split('T')[0];

    try {
        await supabase.from('focus_records').insert([
            { username: username, room_type: roomType, focus_seconds: focusSeconds }
        ]);

        const { data: user } = await supabase
            .from('users')
            .select('*')
            .eq('username', username)
            .single();

        if (user) {
            let newStreak = user.streak;
            if (user.last_login !== today) newStreak += 1; 
            await supabase.from('users')
                .update({ 
                    total_seconds: user.total_seconds + focusSeconds, 
                    streak: newStreak, 
                    last_login: today 
                })
                .eq('username', username);
        } else {
            await supabase.from('users').insert([
                { username: username, total_seconds: focusSeconds, streak: 1, last_login: today, role: 'student' }
            ]);
        }
        res.json({ message: '儲存成功！' });
    } catch (err) {
        console.error("儲存失敗:", err);
        res.status(500).json({ error: '儲存過程發生錯誤' });
    }
});

// ==========================================
// 3. Socket.io 即時連線邏輯
// ==========================================
let onlineUsers = [];
let teacherLogs = []; 
let violationSnaps = []; 

io.on('connection', (socket) => {
    console.log('🔌 指揮官已連線：', socket.id);

    socket.emit('update_rank', onlineUsers);
    socket.emit('teacher_update', { logs: teacherLogs, snaps: violationSnaps });

    socket.on('join_room', async (data) => {
        const username = data.name || '神秘學員';
        try {
            let user = onlineUsers.find(u => u.name === username);
            if (!user) {
                const { data: dbUser } = await supabase
                    .from('users')
                    .select('*')
                    .eq('username', username)
                    .single();

                user = {
                    id: socket.id,
                    name: username,
                    goal: data.goal || '專注學習',
                    status: 'FOCUSED',
                    focusMinutes: 0,
                    score: 0,
                    integrity_score: dbUser ? (dbUser.integrity_score || 100) : 100,
                    streak: dbUser ? dbUser.streak : 1,
                    role: dbUser ? dbUser.role : 'student',
                    isFlipped: false 
                };
                onlineUsers.push(user);
                addTeacherLog(`👤 ${username} 進入了教室`);
            } else {
                user.id = socket.id;
            }
            io.emit('update_rank', onlineUsers);
        } catch (err) {
            console.error("Socket 加入房間錯誤:", err);
        }
    });

    socket.on('update_status', (data) => {
        const user = onlineUsers.find(u => u.name === data.name || u.id === socket.id);
        if (user) { 
            const oldStatus = user.status;
            if (data.status) user.status = data.status;
            
            if (data.isFlipped !== undefined) {
                user.isFlipped = data.isFlipped;
                if(user.isFlipped) {
                    addTeacherLog(`📱 ${user.name} 已翻轉手機進入深度專注`);
                }
            }

            if (oldStatus !== user.status) {
                if (user.status === 'BREAK') {
                    addTeacherLog(`🚽 ${user.name} 申請生理需求 (${data.reason || '未註明'})`);
                } else if (user.status === 'DISTRACTED') {
                    if (!user.isFlipped) {
                        addTeacherLog(`🚨 ${user.name} 偵測到違規行為`);
                    } else {
                        user.status = 'FOCUSED'; 
                    }
                }
            }
            io.emit('update_rank', onlineUsers); 
        }
    });

    socket.on('report_violation', async (data) => {
        const user = onlineUsers.find(u => u.name === data.name);
        if (!user || user.isFlipped) return;

        const newSnap = {
            id: Date.now(),
            name: data.name,
            reason: data.reason,
            image: data.image,
            time: new Date().toLocaleTimeString()
        };

        violationSnaps.unshift(newSnap);
        if (violationSnaps.length > 30) violationSnaps.pop();

        let penalty = 2;
        if (data.reason.includes("手機")) penalty = 10;
        if (data.reason.includes("睡覺")) penalty = 5;

        user.integrity_score = Math.max(0, user.integrity_score - penalty);
        
        try {
            await supabase.from('users')
                .update({ integrity_score: user.integrity_score })
                .eq('username', user.name);
            
            await supabase.from('violation_history').insert([{
                username: user.name,
                reason: data.reason,
                penalty_points: penalty,
                snapshot_url: "Snapshot_Recorded"
            }]);
        } catch (err) {
            console.error("資料庫扣分同步失敗:", err);
        }

        addTeacherLog(`❌ 懲罰: ${user.name} 因 [${data.reason}] 被扣除 ${penalty} 分 (剩餘: ${user.integrity_score})`);
        io.emit('teacher_update', { logs: teacherLogs, snaps: violationSnaps });
        io.emit('update_rank', onlineUsers);
    });

    socket.on('early_leave', async (data) => {
        const user = onlineUsers.find(u => u.name === data.name);
        if (user) {
            user.integrity_score = Math.max(0, user.integrity_score - 15);
            addTeacherLog(`⚠️ 嚴重警告: ${data.name} 惡意早退，誠信分重扣 15 分！`);
            
            await supabase.from('users')
                .update({ integrity_score: user.integrity_score })
                .eq('username', data.name);
        }
    });

    socket.on('admin_action', (data) => {
        io.emit('admin_action', data);
        if(data.type === 'BLACKBOARD') addTeacherLog(`📢 教師公告：${data.content}`);
    });

    socket.on('send_reaction', (data) => {
        io.emit('receive_reaction', data);
    });

    socket.on('disconnect', () => {
        const user = onlineUsers.find(u => u.id === socket.id);
        if (user) {
            addTeacherLog(`👋 ${user.name} 離開了教室`);
            onlineUsers = onlineUsers.filter(u => u.id !== socket.id);
        }
        io.emit('update_rank', onlineUsers);
    });
});

function addTeacherLog(msg) {
    const time = new Date().toLocaleTimeString();
    teacherLogs.unshift(`[${time}] ${msg}`);
    if (teacherLogs.length > 50) teacherLogs.pop();
    io.emit('teacher_update', { logs: teacherLogs, snaps: violationSnaps });
}

setInterval(() => {
    if (onlineUsers.length > 0) {
        onlineUsers.forEach(user => {
            if (user.status === 'FOCUSED') {
                user.score += 1;
                user.focusMinutes = Math.floor(user.score / 60);
            }
        });
        io.emit('update_rank', onlineUsers);
    }
}, 1000);

// ==========================================
// 4. 啟動伺服器 (改為讀取 PORT 環境變數)
// ==========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { 
    console.log(`\n🚀 StudyVerse 核心伺服器啟動！`);
    console.log(`👨‍🏫 管理後端已準備就緒，偵聽端口: ${PORT}`);
});