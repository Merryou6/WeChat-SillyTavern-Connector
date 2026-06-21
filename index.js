import {
    saveSettingsDebounced,
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';
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
} from '../../../../script.js';
import { debounce } from '../../../utils.js';

const extensionName = 'third-party/WeChat-SillyTavern-Connector';
const MODULE_NAME = 'WeChat-SillyTavern-Connector'; // 用于内部标识，与文件夹名一致

const defaultSettings = {
    bridgeUrl: 'ws://127.0.0.1:2334',
    autoConnect: true,
};

let ws = null;
let lastProcessedChatId = null;

// ---------- 设置加载与UI ----------
async function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = value;
        }
    }
    populateUIWithSettings();
}

function populateUIWithSettings() {
    const settings = extension_settings[MODULE_NAME];
    $('#wechat_bridge_url').val(settings.bridgeUrl);
    $('#wechat_auto_connect').prop('checked', settings.autoConnect);
    updateConnectionStatus();
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

async function loadSettingsHTML() {
    // 使用 SillyTavern 的标准模板加载方式，模板文件名为 settings.html
    const settingsHtml = await renderExtensionTemplateAsync(extensionName, 'settings');
    // Idle 插件的容器是 extensions_settings2，我们也保持一致
    const getContainer = () => $(document.getElementById('wechat_container') ?? document.getElementById('extensions_settings2'));
    getContainer().append(settingsHtml);
    // 由于动态加载，需重新绑定事件（在 loadSettings 后调用 setupListeners）
}

// ---------- 设置保存 ----------
function updateSetting(elementId, property, isCheckbox = false) {
    let value = $(`#${elementId}`).val();
    if (isCheckbox) {
        value = $(`#${elementId}`).prop('checked');
    }
    extension_settings[MODULE_NAME][property] = value;
    saveSettingsDebounced();
}

function attachUpdateListener(elementId, property, isCheckbox = false) {
    $(`#${elementId}`).on('input', debounce(() => {
        updateSetting(elementId, property, isCheckbox);
    }, 250));
}

// ---------- WebSocket 连接 ----------
function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    const settings = extension_settings[MODULE_NAME];
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

                // 通知桥接端“正在输入”（微信端忽略）
                ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));

                // 将用户消息加入 SillyTavern
                await sendMessageAsUser(data.text);

                // 触发 AI 生成
                try {
                    const abortController = new AbortController();
                    setExternalAbortController(abortController);
                    await Generate('normal', { signal: abortController.signal });
                } catch (error) {
                    console.error('[WeChat] 生成出错:', error);
                    // 删除刚发送的用户消息，避免残留
                    const context = getContext();
                    if (context.chat.length > 0) {
                        const lastMsg = context.chat[context.chat.length - 1];
                        if (lastMsg && lastMsg.is_user) {
                            context.chat.pop();
                            // 强制刷新 UI（可忽略，或使用其他方法删除）
                        }
                    }
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
                const context = getContext();

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
                                replyText = '可用角色：\n' + chars.map((c, i) => `${i + 1}. /switchchar_${i + 1} - ${c.name}`).join('\n');
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
                            if (context.characterId === undefined) {
                                replyText = '请先选择角色。';
                                break;
                            }
                            const chats = await getPastCharacterChats(context.characterId);
                            if (chats.length > 0) {
                                replyText = '聊天记录：\n' + chats.map((c, i) => `${i + 1}. /switchchat_${i + 1} - ${c.file_name.replace('.jsonl', '')}`).join('\n');
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
                            const charMatch = data.command.match(/^switchchar_(\d+)$/);
                            if (charMatch) {
                                const idx = parseInt(charMatch[1]) - 1;
                                const chars = context.characters.slice(1);
                                if (idx >= 0 && idx < chars.length) {
                                    await selectCharacterById(context.characters.indexOf(chars[idx]));
                                    replyText = `已切换到角色 "${chars[idx].name}"。`;
                                    success = true;
                                } else replyText = `无效序号: ${idx + 1}`;
                                break;
                            }
                            const chatMatch = data.command.match(/^switchchat_(\d+)$/);
                            if (chatMatch) {
                                if (context.characterId === undefined) {
                                    replyText = '请先选择角色。';
                                    break;
                                }
                                const idx = parseInt(chatMatch[1]) - 1;
                                const chats = await getPastCharacterChats(context.characterId);
                                if (idx >= 0 && idx < chats.length) {
                                    const fname = chats[idx].file_name.replace('.jsonl', '');
                                    await openCharacterChat(fname);
                                    replyText = `已加载聊天 "${fname}"。`;
                                    success = true;
                                } else replyText = `无效序号: ${idx + 1}`;
                                break;
                            }
                            replyText = `未知命令: /${data.command}`;
                        }
                    }
                } catch (err) {
                    replyText = `执行出错: ${err.message}`;
                }

                // 发送命令结果（作为 AI 回复显示给微信用户）
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
            console.error('[WeChat] 消息处理错误:', err);
        }
    };

    ws.onclose = () => {
        console.log('[WeChat] 连接已关闭');
        updateConnectionStatus();
        ws = null;
    };
    ws.onerror = (error) => {
        console.error('[WeChat] WebSocket 错误:', error);
        updateConnectionStatus();
        ws = null;
    };
}

function disconnect() {
    if (ws) {
        ws.close();
    }
}

// ---------- 捕获 AI 回复并发送 ----------
function handleFinalMessage(lastMessageId) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !lastProcessedChatId) return;

    const idx = lastMessageId - 1;
    if (idx < 0) return;

    setTimeout(() => {
        const context = getContext();
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

// ---------- 事件监听器设置 ----------
function setupListeners() {
    // 设置项监听
    attachUpdateListener('wechat_bridge_url', 'bridgeUrl');
    attachUpdateListener('wechat_auto_connect', 'autoConnect', true);

    // 按钮
    $('#wechat_connect_button').on('click', connect);
    $('#wechat_disconnect_button').on('click', disconnect);

    // 自动连接
    if (extension_settings[MODULE_NAME].autoConnect) {
        connect();
    }
}

// ---------- 初始化 ----------
jQuery(async () => {
    await loadSettingsHTML();   // 加载设置面板HTML
    await loadSettings();       // 初始化默认设置并填充UI
    setupListeners();           // 绑定事件

    // 监听 AI 生成结束事件
    eventSource.on(event_types.GENERATION_ENDED, handleFinalMessage);
    eventSource.on(event_types.GENERATION_STOPPED, handleFinalMessage);

    console.log('[WeChat-Connector] 扩展已加载');
});
