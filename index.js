import {
    eventSource,
    event_types,
    getPastCharacterChats,
    sendMessageAsUser,
    doNewChat,
    selectCharacterById,
    openCharacterChat,
    Generate,
    setExternalAbortController,
    saveSettingsDebounced,
    extension_settings,
} from '../../../../script.js';

const MODULE_NAME = 'WeChat-SillyTavern-Connector';
const DEFAULT_SETTINGS = {
    bridgeUrl: 'ws://127.0.0.1:2334',
    autoConnect: true,
};

let ws = null;
let lastProcessedChatId = null;

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    return extension_settings[MODULE_NAME];
}

function updateConnectionStatus() {
    const statusEl = document.getElementById('wechat_connection_status');
    if (!statusEl) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
        statusEl.textContent = '状态： 已连接';
        statusEl.style.color = 'green';
    } else {
        statusEl.textContent = '状态： 未连接';
        statusEl.style.color = 'red';
    }
}

function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    const settings = getSettings();
    if (!settings.bridgeUrl) {
        updateConnectionStatus();
        return;
    }

    updateConnectionStatus();
    ws = new WebSocket(settings.bridgeUrl);

    ws.onopen = () => {
        console.log('[WeChat] 已连接到桥接服务器');
        updateConnectionStatus();
    };

    ws.onmessage = async (event) => {
        let data;
        try {
            data = JSON.parse(event.data);

            if (data.type === 'user_message') {
                lastProcessedChatId = data.chatId;
                console.log('[WeChat] 收到用户消息:', data.text);

                ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));
                await sendMessageAsUser(data.text);

                try {
                    const abortController = new AbortController();
                    setExternalAbortController(abortController);
                    await Generate('normal', { signal: abortController.signal });
                } catch (error) {
                    console.error('[WeChat] 生成出错:', error);
                    ws.send(JSON.stringify({
                        type: 'error_message',
                        chatId: data.chatId,
                        text: `生成失败：${error.message}，消息已撤回。`,
                    }));
                }
                return;
            }

            if (data.type === 'execute_command') {
                console.log('[WeChat] 执行命令:', data.command);
                let replyText = '命令执行失败';
                let success = false;
                const context = SillyTavern.getContext();

                try {
                    // 命令处理部分与之前完全一致，省略以避免过长，实际请复制你已有的命令处理逻辑
                    // 这里保留你之前写好的 switch 逻辑...
                } catch (err) {
                    replyText = `执行出错: ${err.message}`;
                }

                ws.send(JSON.stringify({ type: 'ai_reply', chatId: data.chatId, text: replyText }));
                ws.send(JSON.stringify({ type: 'command_executed', command: data.command, success, message: replyText }));
                return;
            }
        } catch (err) {
            console.error('[WeChat] 消息处理错误:', err);
        }
    };

    ws.onclose = () => { console.log('[WeChat] 连接已关闭'); updateConnectionStatus(); ws = null; };
    ws.onerror = () => { console.error('[WeChat] WebSocket 错误'); updateConnectionStatus(); ws = null; };
}

function disconnect() {
    if (ws) ws.close();
}

// ---------- 关键的设置加载部分，完全照搬 Telegram 的成功方式 ----------
jQuery(async () => {
    console.log('[WeChat-Connector] 正在加载设置 UI...');
    try {
        // 直接通过 HTTP 请求加载 settings.html
        const settingsHtml = await $.get(`/scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
        $('#extensions_settings').append(settingsHtml);
        console.log('[WeChat-Connector] 设置 UI 已添加');

        // 填充 UI 默认值
        const settings = getSettings();
        $('#wechat_bridge_url').val(settings.bridgeUrl);
        $('#wechat_auto_connect').prop('checked', settings.autoConnect);
        updateConnectionStatus();

        // 绑定保存事件
        $('#wechat_bridge_url').on('input', () => {
            const s = getSettings();
            s.bridgeUrl = $('#wechat_bridge_url').val();
            saveSettingsDebounced();
        });
        $('#wechat_auto_connect').on('change', function () {
            const s = getSettings();
            s.autoConnect = $(this).prop('checked');
            saveSettingsDebounced();
        });

        // 连接/断开按钮
        $('#wechat_connect_button').on('click', connect);
        $('#wechat_disconnect_button').on('click', disconnect);

        // 自动连接
        if (settings.autoConnect) {
            connect();
        }
    } catch (error) {
        console.error('[WeChat-Connector] 加载设置 HTML 失败:', error);
    }

    // 全局事件：生成结束后发送回复
    eventSource.on(event_types.GENERATION_ENDED, (lastMessageId) => {
        if (!ws || ws.readyState !== WebSocket.OPEN || !lastProcessedChatId) return;
        const idx = lastMessageId - 1;
        if (idx < 0) return;
        setTimeout(() => {
            const context = SillyTavern.getContext();
            const msg = context.chat[idx];
            if (msg && !msg.is_user && !msg.is_system) {
                const el = $(`#chat .mes[mesid="${idx}"] .mes_text`);
                if (el.length > 0) {
                    let rendered = el.html()
                        .replace(/<br\s*\/?>/gi, '\n')
                        .replace(/<\/p>\s*<p>/gi, '\n\n');
                    const div = document.createElement('div');
                    div.innerHTML = rendered;
                    rendered = div.textContent;
                    ws.send(JSON.stringify({ type: 'ai_reply', chatId: lastProcessedChatId, text: rendered }));
                    lastProcessedChatId = null;
                }
            }
        }, 100);
    });
    eventSource.on(event_types.GENERATION_STOPPED, (lastMessageId) => {
        // 复用同样逻辑，可调用相同函数
    });

    console.log('[WeChat-Connector] 扩展已加载');
});
