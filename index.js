const MODULE_NAME = 'WeChat-Connector';
const DEFAULT_SETTINGS = {
    bridgeUrl: 'ws://127.0.0.1:2334',
    autoConnect: true,
};

// 从 SillyTavern 获取 API
const {
    extensionSettings,
    deleteLastMessage,
    saveSettingsDebounced,
} = SillyTavern.getContext();

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
} from "../../../../script.js";

let ws = null;
let lastProcessedChatId = null;

function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    return extensionSettings[MODULE_NAME];
}

function updateStatus(message, color) {
    const el = document.getElementById('wechat_connection_status');
    if (el) {
        el.textContent = `状态： ${message}`;
        el.style.color = color;
    }
}

function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    const settings = getSettings();
    if (!settings.bridgeUrl) {
        updateStatus('URL 未设置', 'red');
        return;
    }

    updateStatus('连接中...', 'orange');
    ws = new WebSocket(settings.bridgeUrl);

    ws.onopen = () => {
        console.log('[Wechat Bridge] 已连接到桥接服务器');
        updateStatus('已连接', 'green');
    };

    ws.onmessage = async (event) => {
        let data;
        try {
            data = JSON.parse(event.data);

            if (data.type === 'user_message') {
                lastProcessedChatId = data.chatId;
                console.log('[Wechat Bridge] 收到用户消息:', data.text);

                // 通知服务器“输入中”（微信端忽略）
                ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));

                // 发送用户消息到 SillyTavern
                await sendMessageAsUser(data.text);

                // 触发 AI 生成（非流式，直接等待结束）
                try {
                    const abortController = new AbortController();
                    setExternalAbortController(abortController);
                    await Generate('normal', { signal: abortController.signal });
                    // 生成完成后，handleFinalMessage 会发送完整回复
                } catch (error) {
                    console.error('[Wechat Bridge] 生成出错:', error);
                    await deleteLastMessage();
                    ws.send(JSON.stringify({
                        type: 'error_message',
                        chatId: data.chatId,
                        text: `生成失败：${error.message}，消息已撤回。`,
                    }));
                }
                return;
            }

            if (data.type === 'execute_command') {
                console.log('[Wechat Bridge] 执行命令:', data.command);
                let replyText = '命令执行失败';
                let success = false;
                const context = SillyTavern.getContext();

                try {
                    switch (data.command) {
                        case 'new':
                            await doNewChat({ deleteCurrentChat: false });
                            replyText = '新聊天已开始。';
                            success = true;
                            break;
                        case 'listchars': {
                            const chars = context.characters.slice(1);
                            if (chars.length > 0) {
                                replyText = '可用角色：\n' + chars.map((c, i) => `${i+1}. /switchchar_${i+1} - ${c.name}`).join('\n');
                            } else replyText = '没有可用角色。';
                            success = true;
                            break;
                        }
                        case 'switchchar': {
                            const name = data.args.join(' ');
                            const char = context.characters.find(c => c.name === name);
                            if (char) {
                                await selectCharacterById(context.characters.indexOf(char));
                                replyText = `已切换到角色 "${name}"。`;
                                success = true;
                            } else replyText = `角色 "${name}" 未找到。`;
                            break;
                        }
                        case 'listchats': {
                            if (context.characterId === undefined) { replyText = '请先选择角色。'; break; }
                            const chats = await getPastCharacterChats(context.characterId);
                            if (chats.length > 0) {
                                replyText = '聊天记录：\n' + chats.map((c, i) => `${i+1}. /switchchat_${i+1} - ${c.file_name.replace('.jsonl','')}`).join('\n');
                            } else replyText = '当前角色没有聊天记录。';
                            success = true;
                            break;
                        }
                        case 'switchchat': {
                            const name = data.args.join(' ');
                            try {
                                await openCharacterChat(name);
                                replyText = `已加载聊天 "${name}"。`;
                                success = true;
                            } catch { replyText = `加载聊天 "${name}" 失败。`; }
                            break;
                        }
                        default: {
                            // switchchar_数字 等
                            const charMatch = data.command.match(/^switchchar_(\d+)$/);
                            if (charMatch) {
                                const idx = parseInt(charMatch[1]) - 1;
                                const chars = context.characters.slice(1);
                                if (idx >= 0 && idx < chars.length) {
                                    await selectCharacterById(context.characters.indexOf(chars[idx]));
                                    replyText = `已切换到角色 "${chars[idx].name}"。`;
                                    success = true;
                                } else replyText = `无效序号: ${idx+1}`;
                                break;
                            }
                            const chatMatch = data.command.match(/^switchchat_(\d+)$/);
                            if (chatMatch) {
                                if (context.characterId === undefined) { replyText = '请先选择角色。'; break; }
                                const idx = parseInt(chatMatch[1]) - 1;
                                const chats = await getPastCharacterChats(context.characterId);
                                if (idx >= 0 && idx < chats.length) {
                                    const fname = chats[idx].file_name.replace('.jsonl','');
                                    await openCharacterChat(fname);
                                    replyText = `已加载聊天 "${fname}"。`;
                                    success = true;
                                } else replyText = `无效序号: ${idx+1}`;
                                break;
                            }
                            replyText = `未知命令: /${data.command}`;
                        }
                    }
                } catch (err) {
                    replyText = `执行出错: ${err.message}`;
                }

                // 发送命令结果（作为 ai_reply 让微信展示）
                ws.send(JSON.stringify({
                    type: 'ai_reply',
                    chatId: data.chatId,
                    text: replyText,
                }));
                ws.send(JSON.stringify({
                    type: 'command_executed',
                    command: data.command,
                    success: success,
                    message: replyText,
                }));
                return;
            }
        } catch (err) {
            console.error('[Wechat Bridge] 消息处理错误:', err);
        }
    };

    ws.onclose = () => {
        updateStatus('连接断开', 'red');
        ws = null;
    };
    ws.onerror = () => {
        updateStatus('连接错误', 'red');
        ws = null;
    };
}

function disconnect() {
    if (ws) ws.close();
}

// 捕获 AI 生成结束，发送完整回复
function handleFinalMessage(lastMessageId) {
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

                ws.send(JSON.stringify({
                    type: 'ai_reply',
                    chatId: lastProcessedChatId,
                    text: rendered,
                }));
                lastProcessedChatId = null;
            }
        }
    }, 100);
}

eventSource.on(event_types.GENERATION_ENDED, handleFinalMessage);
eventSource.on(event_types.GENERATION_STOPPED, handleFinalMessage);

// 扩展加载入口
jQuery(async () => {
    const html = await $.get(`/scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
    $('#extensions_settings').append(html);

    const settings = getSettings();
    $('#wechat_bridge_url').val(settings.bridgeUrl);
    $('#wechat_auto_connect').prop('checked', settings.autoConnect);

    $('#wechat_bridge_url').on('input', () => {
        settings.bridgeUrl = $('#wechat_bridge_url').val();
        saveSettingsDebounced();
    });
    $('#wechat_auto_connect').on('change', function () {
        settings.autoConnect = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#wechat_connect_button').on('click', connect);
    $('#wechat_disconnect_button').on('click', disconnect);

    if (settings.autoConnect) connect();
});
