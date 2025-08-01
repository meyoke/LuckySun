// Move chat functions here from script.js (eventually)

import { Popper, css, DOMPurify } from '../lib.js';
import {
    addCopyToCodeBlocks,
    appendMediaToMessage,
    characters,
    chat,
    eventSource,
    event_types,
    getCurrentChatId,
    getRequestHeaders,
    hideSwipeButtons,
    name1,
    name2,
    reloadCurrentChat,
    saveChatDebounced,
    saveSettingsDebounced,
    showSwipeButtons,
    this_chid,
    saveChatConditional,
    chat_metadata,
    neutralCharacterName,
    updateChatMetadata,
    system_message_types,
    converter,
    substituteParams,
    getSystemMessageByType,
    printMessages,
    clearChat,
} from '../script.js';
import { selected_group } from './group-chats.js';
import { power_user } from './power-user.js';
import {
    extractTextFromHTML,
    extractTextFromMarkdown,
    extractTextFromPDF,
    extractTextFromEpub,
    getBase64Async,
    getStringHash,
    humanFileSize,
    saveBase64AsFile,
    extractTextFromOffice,
    download,
    getFileText,
    getFileExtension,
    convertTextToBase64,
} from './utils.js';
import { extension_settings, renderExtensionTemplateAsync, saveMetadataDebounced } from './extensions.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup } from './popup.js';
import { ScraperManager } from './scrapers.js';
import { DragAndDropHandler } from './dragdrop.js';
import { renderTemplateAsync } from './templates.js';
import { t } from './i18n.js';
import { humanizedDateTime } from './RossAscends-mods.js';
import { accountStorage } from './util/AccountStorage.js';

/**
 * @typedef {Object} FileAttachment
 * @property {string} url File URL
 * @property {number} size File size
 * @property {string} name File name
 * @property {number} created Timestamp
 * @property {string} [text] File text
 */

/**
 * @typedef {function} ConverterFunction
 * @param {File} file File object
 * @returns {Promise<string>} Converted file text
 */

const fileSizeLimit = 1024 * 1024 * 350; // 350 MB
const ATTACHMENT_SOURCE = {
    GLOBAL: 'global',
    CHARACTER: 'character',
    CHAT: 'chat',
};

/**
 * @type {Record<string, ConverterFunction>} File converters
 */
const converters = {
    'application/pdf': extractTextFromPDF,
    'text/html': extractTextFromHTML,
    'text/markdown': extractTextFromMarkdown,
    'application/epub+zip': extractTextFromEpub,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': extractTextFromOffice,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': extractTextFromOffice,
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': extractTextFromOffice,
    'application/vnd.oasis.opendocument.text': extractTextFromOffice,
    'application/vnd.oasis.opendocument.presentation': extractTextFromOffice,
    'application/vnd.oasis.opendocument.spreadsheet': extractTextFromOffice,
};

/**
 * Finds a matching key in the converters object.
 * @param {string} type MIME type
 * @returns {string} Matching key
 */
function findConverterKey(type) {
    return Object.keys(converters).find((key) => {
        // Match exact type
        if (type === key) {
            return true;
        }

        // Match wildcards
        if (key.endsWith('*')) {
            return type.startsWith(key.substring(0, key.length - 1));
        }

        return false;
    });
}

/**
 * Determines if the file type has a converter function.
 * @param {string} type MIME type
 * @returns {boolean} True if the file type is convertible, false otherwise.
 */
function isConvertible(type) {
    return Boolean(findConverterKey(type));
}

/**
 * Gets the converter function for a file type.
 * @param {string} type MIME type
 * @returns {ConverterFunction} Converter function
 */
function getConverter(type) {
    const key = findConverterKey(type);
    return key && converters[key];
}

/**
 * Mark a range of messages as hidden ("is_system") or not.
 * @param {number} start Starting message ID
 * @param {number} end Ending message ID (inclusive)
 * @param {boolean} unhide If true, unhide the messages instead.
 * @param {string} nameFitler Optional name filter
 * @returns {Promise<void>}
 */
export async function hideChatMessageRange(start, end, unhide, nameFitler = null) {
    if (isNaN(start)) return;
    if (!end) end = start;
    const hide = !unhide;

    for (let messageId = start; messageId <= end; messageId++) {
        const message = chat[messageId];
        if (!message) continue;
        if (nameFitler && message.name !== nameFitler) continue;

        message.is_system = hide;

        // Also toggle "hidden" state for all visible messages
        const messageBlock = $(`.mes[mesid="${messageId}"]`);
        if (!messageBlock.length) continue;
        messageBlock.attr('is_system', String(hide));
    }

    // Reload swipes. Useful when a last message is hidden.
    hideSwipeButtons();
    showSwipeButtons();

    saveChatDebounced();
}

/**
 * Mark message as hidden (system message).
 * @deprecated Use hideChatMessageRange.
 * @param {number} messageId Message ID
 * @param {JQuery<Element>} _messageBlock Unused
 * @returns {Promise<void>}
 */
export async function hideChatMessage(messageId, _messageBlock) {
    return hideChatMessageRange(messageId, messageId, false);
}

/**
 * Mark message as visible (non-system message).
 * @deprecated Use hideChatMessageRange.
 * @param {number} messageId Message ID
 * @param {JQuery<Element>} _messageBlock Unused
 * @returns {Promise<void>}
 */
export async function unhideChatMessage(messageId, _messageBlock) {
    return hideChatMessageRange(messageId, messageId, true);
}

/**
 * Adds a file attachment to the message.
 * @param {object} message Message object
 * @returns {Promise<void>} A promise that resolves when file is uploaded.
 */
export async function populateFileAttachment(message, inputId = 'file_form_input') {
    try {
        if (!message) return;
        if (!message.extra) message.extra = {};
        const fileInput = document.getElementById(inputId);
        if (!(fileInput instanceof HTMLInputElement)) return;
        const file = fileInput.files[0];
        if (!file) return;

        const slug = getStringHash(file.name);
        const fileNamePrefix = `${Date.now()}_${slug}`;
        const fileBase64 = await getBase64Async(file);
        let base64Data = fileBase64.split(',')[1];
        const extension = getFileExtension(file);

        // If file is image
        if (file.type.startsWith('image/')) {
            const imageUrl = await saveBase64AsFile(base64Data, name2, fileNamePrefix, extension);
            message.extra.image = imageUrl;
            message.extra.inline_image = true;
        }
        // If file is video
        else if (file.type.startsWith('video/')) {
            const videoUrl = await saveBase64AsFile(base64Data, name2, fileNamePrefix, extension);
            message.extra.video = videoUrl;
        } else {
            const uniqueFileName = `${fileNamePrefix}.txt`;

            if (isConvertible(file.type)) {
                try {
                    const converter = getConverter(file.type);
                    const fileText = await converter(file);
                    base64Data = convertTextToBase64(fileText);
                } catch (error) {
                    toastr.error(String(error), t`Could not convert file`);
                    console.error('Could not convert file', error);
                }
            }

            const fileUrl = await uploadFileAttachment(uniqueFileName, base64Data);

            if (!fileUrl) {
                return;
            }

            message.extra.file = {
                url: fileUrl,
                size: file.size,
                name: file.name,
                created: Date.now(),
            };
        }

    } catch (error) {
        console.error('Could not upload file', error);
        toastr.error(t`Either the file is corrupted or its format is not supported.`, t`Could not upload the file`);
    } finally {
        $('#file_form').trigger('reset');
    }
}

/**
 * Uploads file to the server.
 * @param {string} fileName
 * @param {string} base64Data
 * @returns {Promise<string>} File URL
 */
export async function uploadFileAttachment(fileName, base64Data) {
    try {
        const result = await fetch('/api/files/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                name: fileName,
                data: base64Data,
            }),
        });

        if (!result.ok) {
            const error = await result.text();
            throw new Error(error);
        }

        const responseData = await result.json();
        return responseData.path;
    } catch (error) {
        toastr.error(String(error), t`Could not upload file`);
        console.error('Could not upload file', error);
    }
}

/**
 * Downloads file from the server.
 * @param {string} url File URL
 * @returns {Promise<string>} File text
 */
export async function getFileAttachment(url) {
    try {
        const result = await fetch(url, {
            method: 'GET',
            cache: 'force-cache',
            headers: getRequestHeaders(),
        });

        if (!result.ok) {
            const error = await result.text();
            throw new Error(error);
        }

        const text = await result.text();
        return text;
    } catch (error) {
        toastr.error(error, t`Could not download file`);
        console.error('Could not download file', error);
    }
}

/**
 * Validates file to make sure it is not binary or not image.
 * @param {File} file File object
 * @returns {Promise<boolean>} True if file is valid, false otherwise.
 */
async function validateFile(file) {
    const fileText = await file.text();
    const isImage = file.type.startsWith('image/');
    const isBinary = /^[\x00-\x08\x0E-\x1F\x7F-\xFF]*$/.test(fileText);

    if (!isImage && file.size > fileSizeLimit) {
        toastr.error(t`File is too big. Maximum size is ${humanFileSize(fileSizeLimit)}.`);
        return false;
    }

    // If file is binary
    if (isBinary && !isImage && !isConvertible(file.type)) {
        toastr.error(t`Binary files are not supported. Select a text file or image.`);
        return false;
    }

    return true;
}

export function hasPendingFileAttachment() {
    const fileInput = document.getElementById('file_form_input');
    if (!(fileInput instanceof HTMLInputElement)) return false;
    const file = fileInput.files[0];
    return !!file;
}

/**
 * Displays file information in the message sending form.
 * @param {File} file File object
 * @returns {Promise<void>}
 */
async function onFileAttach(file) {
    if (!file) return;

    const isValid = await validateFile(file);

    // If file is binary
    if (!isValid) {
        $('#file_form').trigger('reset');
        return;
    }

    $('#file_form .file_name').text(file.name);
    $('#file_form .file_size').text(humanFileSize(file.size));
    $('#file_form').removeClass('displayNone');

    // Reset form on chat change (if not on a welcome screen)
    const currentChatId = getCurrentChatId();
    if (currentChatId) {
        eventSource.once(event_types.CHAT_CHANGED, () => {
            $('#file_form').trigger('reset');
        });
    }
}

/**
 * Deletes file from message.
 * @param {number} messageId Message ID
 */
async function deleteMessageFile(messageId) {
    const confirm = await callGenericPopup('Are you sure you want to delete this file?', POPUP_TYPE.CONFIRM);

    if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
        console.debug('Delete file cancelled');
        return;
    }

    const message = chat[messageId];

    if (!message?.extra?.file) {
        console.debug('Message has no file');
        return;
    }

    const url = message.extra.file.url;

    delete message.extra.file;
    $(`.mes[mesid="${messageId}"] .mes_file_container`).remove();
    await saveChatConditional();
    await deleteFileFromServer(url);
}


/**
 * Opens file from message in a modal.
 * @param {number} messageId Message ID
 */
async function viewMessageFile(messageId) {
    const messageFile = chat[messageId]?.extra?.file;

    if (!messageFile) {
        console.debug('Message has no file or it is empty');
        return;
    }

    await openFilePopup(messageFile);
}

/**
 * Inserts a file embed into the message.
 * @param {number} messageId
 * @param {JQuery<HTMLElement>} messageBlock
 * @returns {Promise<void>}
 */
function embedMessageFile(messageId, messageBlock) {
    const message = chat[messageId];

    if (!message) {
        console.warn('Failed to find message with id', messageId);
        return;
    }

    $('#embed_file_input')
        .off('change')
        .on('change', parseAndUploadEmbed)
        .trigger('click');

    async function parseAndUploadEmbed(e) {
        const file = e.target.files[0];
        if (!file) return;

        const isValid = await validateFile(file);

        if (!isValid) {
            $('#file_form').trigger('reset');
            return;
        }

        await populateFileAttachment(message, 'embed_file_input');
        await eventSource.emit(event_types.MESSAGE_FILE_EMBEDDED, messageId);
        appendMediaToMessage(message, messageBlock);
        await saveChatConditional();
    }
}

/**
 * Appends file content to the message text.
 * @param {object} message Message object
 * @param {string} messageText Message text
 * @returns {Promise<string>} Message text with file content appended.
 */
export async function appendFileContent(message, messageText) {
    if (message.extra?.file) {
        const fileText = message.extra.file.text || (await getFileAttachment(message.extra.file.url));

        if (fileText) {
            const fileWrapped = `${fileText}\n\n`;
            message.extra.fileLength = fileWrapped.length;
            messageText = fileWrapped + messageText;
        }
    }
    return messageText;
}

/**
 * Replaces style tags in the message text with custom tags with encoded content.
 * @param {string} text
 * @returns {string} Encoded message text
 * @copyright https://github.com/kwaroran/risuAI
 */
export function encodeStyleTags(text) {
    const styleRegex = /<style>(.+?)<\/style>/gims;
    return text.replaceAll(styleRegex, (_, match) => {
        return `<custom-style>${encodeURIComponent(match)}</custom-style>`;
    });
}

/**
 * Sanitizes custom style tags in the message text to prevent DOM pollution.
 * @param {string} text Message text
 * @param {object} options Options object
 * @param {string} options.prefix Prefix the selectors with this value
 * @returns {string} Sanitized message text
 * @copyright https://github.com/kwaroran/risuAI
 */
export function decodeStyleTags(text, { prefix } = { prefix: '.mes_text ' }) {
    const styleDecodeRegex = /<custom-style>(.+?)<\/custom-style>/gms;
    const mediaAllowed = isExternalMediaAllowed();

    function sanitizeRule(rule) {
        if (Array.isArray(rule.selectors)) {
            for (let i = 0; i < rule.selectors.length; i++) {
                const selector = rule.selectors[i];
                if (selector) {
                    rule.selectors[i] = prefix + sanitizeSelector(selector);
                }
            }
        }
        if (!mediaAllowed && Array.isArray(rule.declarations) && rule.declarations.length > 0) {
            rule.declarations = rule.declarations.filter(declaration => !declaration.value.includes('://'));
        }
    }

    function sanitizeSelector(selector) {
        // Handle pseudo-classes that can contain nested selectors
        const pseudoClasses = ['has', 'not', 'where', 'is', 'matches', 'any'];
        const pseudoRegex = new RegExp(`:(${pseudoClasses.join('|')})\\(([^)]+)\\)`, 'g');

        // First, sanitize any nested selectors within pseudo-classes
        selector = selector.replace(pseudoRegex, (match, pseudoClass, content) => {
            // Recursively sanitize the content within the pseudo-class
            const sanitizedContent = sanitizeSimpleSelector(content);
            return `:${pseudoClass}(${sanitizedContent})`;
        });

        // Then sanitize the main selector parts
        return sanitizeSimpleSelector(selector);
    }

    function sanitizeSimpleSelector(selector) {
        // Split by spaces but preserve complex selectors
        return selector.split(/\s+/).map((part) => {
            // Handle class selectors, but preserve pseudo-classes and other complex parts
            return part.replace(/\.([\w-]+)/g, (match, className) => {
                // Don't modify if it's already prefixed with 'custom-'
                if (className.startsWith('custom-')) {
                    return match;
                }
                return `.custom-${className}`;
            });
        }).join(' ');
    }

    function sanitizeRuleSet(ruleSet) {
        if (Array.isArray(ruleSet.selectors) || Array.isArray(ruleSet.declarations)) {
            sanitizeRule(ruleSet);
        }

        if (Array.isArray(ruleSet.rules)) {
            ruleSet.rules = ruleSet.rules.filter(rule => rule.type !== 'import');

            for (const mediaRule of ruleSet.rules) {
                sanitizeRuleSet(mediaRule);
            }
        }
    }

    return text.replaceAll(styleDecodeRegex, (_, style) => {
        try {
            let styleCleaned = decodeURIComponent(style).replaceAll(/<br\/>/g, '');
            const ast = css.parse(styleCleaned);
            const sheet = ast?.stylesheet;
            if (sheet) {
                sanitizeRuleSet(ast.stylesheet);
            }
            return `<style>${css.stringify(ast)}</style>`;
        } catch (error) {
            return `CSS ERROR: ${error}`;
        }
    });
}

/**
 * Class to manage style preferences for characters.
 */
class StylesPreference {
    /**
     * Creates a new StylesPreference instance.
     * @param {string|null} avatarId - The avatar ID of the character
     */
    constructor(avatarId) {
        this.avatarId = avatarId;
    }

    /**
     * Gets the account storage key for the style preference.
     */
    get key() {
        return `AllowGlobalStyles-${this.avatarId}`;
    }

    /**
     * Checks if a preference exists for this character.
     * @returns {boolean} True if preference exists, false otherwise
     */
    exists() {
        return this.avatarId
            ? accountStorage.getItem(this.key) !== null
            : true; // No character == assume preference is set
    }

    /**
     * Gets the current style preference.
     * @returns {boolean} True if global styles are allowed, false otherwise
     */
    get() {
        return this.avatarId
            ? accountStorage.getItem(this.key) === 'true'
            : false; // Always disabled when creating a new character
    }

    /**
     * Sets the global styles preference.
     * @param {boolean} allowed - Whether global styles are allowed
     */
    set(allowed) {
        if (this.avatarId) {
            accountStorage.setItem(this.key, String(allowed));
        }
    }
}

/**
 * Formats creator notes in the message text.
 * @param {string} text Raw Markdown text
 * @param {string} avatarId Avatar ID
 * @returns {string} Formatted HTML text
 */
export function formatCreatorNotes(text, avatarId) {
    const preference = new StylesPreference(avatarId);
    const sanitizeStyles = !preference.get();
    const decodeStyleParam = { prefix: sanitizeStyles ? '#creator_notes_spoiler ' : '' };
    /** @type {import('dompurify').Config & { MESSAGE_SANITIZE: boolean }} */
    const config = {
        RETURN_DOM: false,
        RETURN_DOM_FRAGMENT: false,
        RETURN_TRUSTED_TYPE: false,
        MESSAGE_SANITIZE: true,
        ADD_TAGS: ['custom-style'],
    };

    let html = converter.makeHtml(substituteParams(text));
    html = encodeStyleTags(html);
    html = DOMPurify.sanitize(html, config);
    html = decodeStyleTags(html, decodeStyleParam);

    return html;
}

async function openGlobalStylesPreferenceDialog() {
    if (selected_group) {
        toastr.info(t`To change the global styles preference, please select a character individually.`);
        return;
    }

    const entityId = getCurrentEntityId();
    const preference = new StylesPreference(entityId);
    const currentValue = preference.get();

    const template = $(await renderTemplateAsync('globalStylesPreference'));

    const allowedRadio = template.find('#global_styles_allowed');
    const forbiddenRadio = template.find('#global_styles_forbidden');

    allowedRadio.on('change', () => {
        preference.set(true);
        allowedRadio.prop('checked', true);
        forbiddenRadio.prop('checked', false);
    });

    forbiddenRadio.on('change', () => {
        preference.set(false);
        allowedRadio.prop('checked', false);
        forbiddenRadio.prop('checked', true);
    });

    const currentPreferenceRadio = currentValue ? allowedRadio : forbiddenRadio;
    template.find(currentPreferenceRadio).prop('checked', true);

    await callGenericPopup(template, POPUP_TYPE.TEXT, '', { wide: false, large: false });

    // Re-render the notes if the preference changed
    const newValue = preference.get();
    if (newValue !== currentValue) {
        $('#rm_button_selected_ch').trigger('click');
        setGlobalStylesButtonClass(newValue);
    }
}

async function checkForCreatorNotesStyles() {
    // Don't do anything if in group chat or not in a chat
    if (selected_group || this_chid === undefined) {
        return;
    }

    const notes = characters[this_chid].data?.creator_notes || characters[this_chid].creatorcomment;
    const avatarId = characters[this_chid].avatar;
    const styleContents = getStyleContentsFromMarkdown(notes);

    if (!styleContents) {
        setGlobalStylesButtonClass(null);
        return;
    }

    const preference = new StylesPreference(avatarId);
    const hasPreference = preference.exists();
    if (!hasPreference) {
        const template = $(await renderTemplateAsync('globalStylesPopup'));
        template.find('textarea').val(styleContents);
        const confirmResult = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '', {
            wide: false,
            large: false,
            okButton: t`Just to Creator's Notes`,
            cancelButton: t`Apply to the entire app`,
        });

        switch (confirmResult) {
            case POPUP_RESULT.AFFIRMATIVE:
                preference.set(false);
                break;
            case POPUP_RESULT.NEGATIVE:
                preference.set(true);
                break;
            case POPUP_RESULT.CANCELLED:
                preference.set(false);
                break;
        }

        $('#rm_button_selected_ch').trigger('click');
    }

    const currentPreference = preference.get();
    setGlobalStylesButtonClass(currentPreference);
}

/**
 * Sets the class of the global styles button based on the state.
 * @param {boolean|null} state State of the button
 */
function setGlobalStylesButtonClass(state) {
    const button = $('#creators_note_styles_button');
    button.toggleClass('empty', state === null);
    button.toggleClass('allowed', state === true);
    button.toggleClass('forbidden', state === false);
}

/**
 * Extracts the contents of all style elements from the Markdown text.
 * @param {string} text Markdown text
 * @returns {string} The joined contents of all style elements
 */
function getStyleContentsFromMarkdown(text) {
    if (!text) {
        return '';
    }

    const div = document.createElement('div');
    const html = converter.makeHtml(substituteParams(text));
    div.innerHTML = html;
    const styleElements = Array.from(div.querySelectorAll('style'));
    return styleElements
        .filter(s => s.textContent.trim().length > 0)
        .map(s => s.textContent.trim())
        .join('\n\n');
}

async function openExternalMediaOverridesDialog() {
    const entityId = getCurrentEntityId();

    if (!entityId) {
        toastr.info(t`No character or group selected`);
        return;
    }

    const template = $(await renderTemplateAsync('forbidMedia'));
    template.find('.forbid_media_global_state_forbidden').toggle(power_user.forbid_external_media);
    template.find('.forbid_media_global_state_allowed').toggle(!power_user.forbid_external_media);

    if (power_user.external_media_allowed_overrides.includes(entityId)) {
        template.find('#forbid_media_override_allowed').prop('checked', true);
    }
    else if (power_user.external_media_forbidden_overrides.includes(entityId)) {
        template.find('#forbid_media_override_forbidden').prop('checked', true);
    }
    else {
        template.find('#forbid_media_override_global').prop('checked', true);
    }

    callGenericPopup(template, POPUP_TYPE.TEXT, '', { wide: false, large: false });
}

export function getCurrentEntityId() {
    if (selected_group) {
        return String(selected_group);
    }

    return characters[this_chid]?.avatar ?? null;
}

export function isExternalMediaAllowed() {
    const entityId = getCurrentEntityId();
    if (!entityId) {
        return !power_user.forbid_external_media;
    }

    if (power_user.external_media_allowed_overrides.includes(entityId)) {
        return true;
    }

    if (power_user.external_media_forbidden_overrides.includes(entityId)) {
        return false;
    }

    return !power_user.forbid_external_media;
}

function expandMessageImage(event) {
    const mesBlock = $(event.currentTarget).closest('.mes');
    const mesId = mesBlock.attr('mesid');
    const message = chat[mesId];
    const imgSrc = message?.extra?.image;
    const title = message?.extra?.title;

    if (!imgSrc) {
        return;
    }

    const img = document.createElement('img');
    img.classList.add('img_enlarged');
    img.src = imgSrc;
    const imgHolder = document.createElement('div');
    imgHolder.classList.add('img_enlarged_holder');
    imgHolder.append(img);
    const imgContainer = $('<div><pre><code class="img_enlarged_title"></code></pre></div>');
    imgContainer.prepend(imgHolder);
    imgContainer.addClass('img_enlarged_container');

    const codeTitle = imgContainer.find('.img_enlarged_title');
    codeTitle.addClass('txt').text(title);
    const titleEmpty = !title || title.trim().length === 0;
    imgContainer.find('pre').toggle(!titleEmpty);
    addCopyToCodeBlocks(imgContainer);

    const popup = new Popup(imgContainer, POPUP_TYPE.DISPLAY, '', { large: true, transparent: true });

    popup.dlg.style.width = 'unset';
    popup.dlg.style.height = 'unset';

    img.addEventListener('click', event => {
        const shouldZoom = !img.classList.contains('zoomed');
        img.classList.toggle('zoomed', shouldZoom);
        event.stopPropagation();
    });
    codeTitle[0]?.addEventListener('click', event => {
        event.stopPropagation();
    });

    popup.dlg.addEventListener('click', event => {
        popup.completeCancelled();
    });

    popup.show();
    return img;
}

function expandAndZoomMessageImage(event) {
    expandMessageImage(event).click();
}

async function deleteMessageImage() {
    const value = await callGenericPopup('<h3>Delete image from message?<br>This action can\'t be undone.</h3>', POPUP_TYPE.TEXT, '', {
        okButton: t`Delete one`,
        customButtons: [
            {
                text: t`Delete all`,
                appendAtEnd: true,
                result: POPUP_RESULT.CUSTOM1,
            },
            {
                text: t`Cancel`,
                appendAtEnd: true,
                result: POPUP_RESULT.CANCELLED,
            },
        ],
    });

    if (!value) {
        return;
    }

    const mesBlock = $(this).closest('.mes');
    const mesId = mesBlock.attr('mesid');
    const message = chat[mesId];

    let isLastImage = true;

    if (Array.isArray(message.extra.image_swipes)) {
        const indexOf = message.extra.image_swipes.indexOf(message.extra.image);
        if (indexOf > -1) {
            message.extra.image_swipes.splice(indexOf, 1);
            isLastImage = message.extra.image_swipes.length === 0;
            if (!isLastImage) {
                const newIndex = Math.min(indexOf, message.extra.image_swipes.length - 1);
                message.extra.image = message.extra.image_swipes[newIndex];
            }
        }
    }

    if (isLastImage || value === POPUP_RESULT.CUSTOM1) {
        delete message.extra.image;
        delete message.extra.inline_image;
        delete message.extra.title;
        delete message.extra.append_title;
        delete message.extra.image_swipes;
        mesBlock.find('.mes_img_container').removeClass('img_extra');
        mesBlock.find('.mes_img').attr('src', '');
    } else {
        appendMediaToMessage(message, mesBlock);
    }

    await saveChatConditional();
}

async function deleteMessageVideo() {
    const confirm = await Popup.show.confirm(t`Delete video from message?`, t`This action can't be undone.`);
    if (!confirm) {
        return;
    }

    const mesBlock = $(this).closest('.mes');
    const mesId = mesBlock.attr('mesid');
    const message = chat[mesId];

    if (!message?.extra?.video) {
        console.warn('Message has no video or it is empty');
        return;
    }

    delete message.extra.video;
    mesBlock.find('.mes_video_container').remove();

    await saveChatConditional();
}

/**
 * Deletes file from the server.
 * @param {string} url Path to the file on the server
 * @param {boolean} [silent=false] If true, do not show error messages
 * @returns {Promise<boolean>} True if file was deleted, false otherwise.
 */
async function deleteFileFromServer(url, silent = false) {
    try {
        const result = await fetch('/api/files/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: url }),
        });

        if (!result.ok && !silent) {
            const error = await result.text();
            throw new Error(error);
        }

        await eventSource.emit(event_types.FILE_ATTACHMENT_DELETED, url);
        return true;
    } catch (error) {
        toastr.error(String(error), t`Could not delete file`);
        console.error('Could not delete file', error);
        return false;
    }
}

/**
 * Opens file attachment in a modal.
 * @param {FileAttachment} attachment File attachment
 */
async function openFilePopup(attachment) {
    const fileText = attachment.text || (await getFileAttachment(attachment.url));

    const modalTemplate = $('<div><pre><code></code></pre></div>');
    modalTemplate.find('code').addClass('txt').text(fileText);
    modalTemplate.addClass('file_modal').addClass('textarea_compact').addClass('fontsize90p');
    addCopyToCodeBlocks(modalTemplate);

    callGenericPopup(modalTemplate, POPUP_TYPE.TEXT, '', { wide: true, large: true });
}

/**
 * Edit a file attachment in a notepad-like modal.
 * @param {FileAttachment} attachment Attachment to edit
 * @param {string} source Attachment source
 * @param {function} callback Callback function
 */
async function editAttachment(attachment, source, callback) {
    const originalFileText = attachment.text || (await getFileAttachment(attachment.url));
    const template = $(await renderExtensionTemplateAsync('attachments', 'notepad'));

    let editedFileText = originalFileText;
    template.find('[name="notepadFileContent"]').val(editedFileText).on('input', function () {
        editedFileText = String($(this).val());
    });

    let editedFileName = attachment.name;
    template.find('[name="notepadFileName"]').val(editedFileName).on('input', function () {
        editedFileName = String($(this).val());
    });

    const result = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '', { wide: true, large: true, okButton: 'Save', cancelButton: 'Cancel' });

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    if (editedFileText === originalFileText && editedFileName === attachment.name) {
        return;
    }

    const nullCallback = () => { };
    await deleteAttachment(attachment, source, nullCallback, false);
    const file = new File([editedFileText], editedFileName, { type: 'text/plain' });
    await uploadFileAttachmentToServer(file, source);

    callback();
}

/**
 * Downloads an attachment to the user's device.
 * @param {FileAttachment} attachment Attachment to download
 */
async function downloadAttachment(attachment) {
    const fileText = attachment.text || (await getFileAttachment(attachment.url));
    const blob = new Blob([fileText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = attachment.name;
    a.click();
    URL.revokeObjectURL(url);
}

/**
 * Removes an attachment from the disabled list.
 * @param {FileAttachment} attachment Attachment to enable
 * @param {function} callback Success callback
 */
function enableAttachment(attachment, callback) {
    ensureAttachmentsExist();
    extension_settings.disabled_attachments = extension_settings.disabled_attachments.filter(url => url !== attachment.url);
    saveSettingsDebounced();
    callback();
}

/**
 * Adds an attachment to the disabled list.
 * @param {FileAttachment} attachment Attachment to disable
 * @param {function} callback Success callback
 */
function disableAttachment(attachment, callback) {
    ensureAttachmentsExist();
    extension_settings.disabled_attachments.push(attachment.url);
    saveSettingsDebounced();
    callback();
}

/**
 * Moves a file attachment to a different source.
 * @param {FileAttachment} attachment Attachment to moves
 * @param {string} source Source of the attachment
 * @param {function} callback Success callback
 * @returns {Promise<void>} A promise that resolves when the attachment is moved.
 */
async function moveAttachment(attachment, source, callback) {
    let selectedTarget = source;
    const targets = getAvailableTargets();
    const template = $(await renderExtensionTemplateAsync('attachments', 'move-attachment', { name: attachment.name, targets }));
    template.find('.moveAttachmentTarget').val(source).on('input', function () {
        selectedTarget = String($(this).val());
    });

    const result = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '', { wide: false, large: false, okButton: 'Move', cancelButton: 'Cancel' });

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        console.debug('Move attachment cancelled');
        return;
    }

    if (selectedTarget === source) {
        console.debug('Move attachment cancelled: same source and target');
        return;
    }

    const content = await getFileAttachment(attachment.url);
    const file = new File([content], attachment.name, { type: 'text/plain' });
    await deleteAttachment(attachment, source, () => { }, false);
    await uploadFileAttachmentToServer(file, selectedTarget);
    callback();
}

/**
 * Deletes an attachment from the server and the chat.
 * @param {FileAttachment} attachment Attachment to delete
 * @param {string} source Source of the attachment
 * @param {function} callback Callback function
 * @param {boolean} [confirm=true] If true, show a confirmation dialog
 * @returns {Promise<void>} A promise that resolves when the attachment is deleted.
 */
export async function deleteAttachment(attachment, source, callback, confirm = true) {
    if (confirm) {
        const result = await callGenericPopup('Are you sure you want to delete this attachment?', POPUP_TYPE.CONFIRM);

        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }
    }

    ensureAttachmentsExist();

    switch (source) {
        case 'global':
            extension_settings.attachments = extension_settings.attachments.filter((a) => a.url !== attachment.url);
            saveSettingsDebounced();
            break;
        case 'chat':
            chat_metadata.attachments = chat_metadata.attachments.filter((a) => a.url !== attachment.url);
            saveMetadataDebounced();
            break;
        case 'character':
            extension_settings.character_attachments[characters[this_chid]?.avatar] = extension_settings.character_attachments[characters[this_chid]?.avatar].filter((a) => a.url !== attachment.url);
            break;
    }

    if (Array.isArray(extension_settings.disabled_attachments) && extension_settings.disabled_attachments.includes(attachment.url)) {
        extension_settings.disabled_attachments = extension_settings.disabled_attachments.filter(url => url !== attachment.url);
        saveSettingsDebounced();
    }

    const silent = confirm === false;
    await deleteFileFromServer(attachment.url, silent);
    callback();
}

/**
 * Determines if the attachment is disabled.
 * @param {FileAttachment} attachment Attachment to check
 * @returns {boolean} True if attachment is disabled, false otherwise.
 */
function isAttachmentDisabled(attachment) {
    return extension_settings.disabled_attachments.some(url => url === attachment?.url);
}

/**
 * Opens the attachment manager.
 */
async function openAttachmentManager() {
    /**
     * Renders a list of attachments.
     * @param {FileAttachment[]} attachments List of attachments
     * @param {string} source Source of the attachments
     */
    async function renderList(attachments, source) {
        /**
         * Sorts attachments by sortField and sortOrder.
         * @param {FileAttachment} a First attachment
         * @param {FileAttachment} b Second attachment
         * @returns {number} Sort order
         */
        function sortFn(a, b) {
            const sortValueA = a[sortField];
            const sortValueB = b[sortField];
            if (typeof sortValueA === 'string' && typeof sortValueB === 'string') {
                return sortValueA.localeCompare(sortValueB) * (sortOrder === 'asc' ? 1 : -1);
            }
            return (sortValueA - sortValueB) * (sortOrder === 'asc' ? 1 : -1);
        }

        /**
         * Filters attachments by name.
         * @param {FileAttachment} a Attachment
         * @returns {boolean} True if attachment matches the filter, false otherwise.
         */
        function filterFn(a) {
            if (!filterString) {
                return true;
            }

            return a.name.toLowerCase().includes(filterString.toLowerCase());
        }
        const sources = {
            [ATTACHMENT_SOURCE.GLOBAL]: '.globalAttachmentsList',
            [ATTACHMENT_SOURCE.CHARACTER]: '.characterAttachmentsList',
            [ATTACHMENT_SOURCE.CHAT]: '.chatAttachmentsList',
        };

        const selected = template
            .find(sources[source])
            .find('.attachmentListItemCheckbox:checked')
            .map((_, el) => $(el).closest('.attachmentListItem').attr('data-attachment-url'))
            .get();

        template.find(sources[source]).empty();

        // Sort attachments by sortField and sortOrder, and apply filter
        const sortedAttachmentList = attachments.slice().filter(filterFn).sort(sortFn);

        for (const attachment of sortedAttachmentList) {
            const isDisabled = isAttachmentDisabled(attachment);
            const attachmentTemplate = template.find('.attachmentListItemTemplate .attachmentListItem').clone();
            attachmentTemplate.toggleClass('disabled', isDisabled);
            attachmentTemplate.attr('data-attachment-url', attachment.url);
            attachmentTemplate.attr('data-attachment-source', source);
            attachmentTemplate.find('.attachmentFileIcon').attr('title', attachment.url);
            attachmentTemplate.find('.attachmentListItemName').text(attachment.name);
            attachmentTemplate.find('.attachmentListItemSize').text(humanFileSize(attachment.size));
            attachmentTemplate.find('.attachmentListItemCreated').text(new Date(attachment.created).toLocaleString());
            attachmentTemplate.find('.viewAttachmentButton').on('click', () => openFilePopup(attachment));
            attachmentTemplate.find('.editAttachmentButton').on('click', () => editAttachment(attachment, source, renderAttachments));
            attachmentTemplate.find('.deleteAttachmentButton').on('click', () => deleteAttachment(attachment, source, renderAttachments));
            attachmentTemplate.find('.downloadAttachmentButton').on('click', () => downloadAttachment(attachment));
            attachmentTemplate.find('.moveAttachmentButton').on('click', () => moveAttachment(attachment, source, renderAttachments));
            attachmentTemplate.find('.enableAttachmentButton').toggle(isDisabled).on('click', () => enableAttachment(attachment, renderAttachments));
            attachmentTemplate.find('.disableAttachmentButton').toggle(!isDisabled).on('click', () => disableAttachment(attachment, renderAttachments));
            template.find(sources[source]).append(attachmentTemplate);

            if (selected.includes(attachment.url)) {
                attachmentTemplate.find('.attachmentListItemCheckbox').prop('checked', true);
            }
        }
    }

    /**
     * Renders buttons for the attachment manager.
     */
    async function renderButtons() {
        const sources = {
            [ATTACHMENT_SOURCE.GLOBAL]: '.globalAttachmentsTitle',
            [ATTACHMENT_SOURCE.CHARACTER]: '.characterAttachmentsTitle',
            [ATTACHMENT_SOURCE.CHAT]: '.chatAttachmentsTitle',
        };

        const modal = template.find('.actionButtonsModal').hide();
        const scrapers = ScraperManager.getDataBankScrapers();

        for (const scraper of scrapers) {
            const isAvailable = await ScraperManager.isScraperAvailable(scraper.id);
            if (!isAvailable) {
                continue;
            }

            const buttonTemplate = template.find('.actionButtonTemplate .actionButton').clone();
            if (scraper.iconAvailable) {
                buttonTemplate.find('.actionButtonIcon').addClass(scraper.iconClass);
                buttonTemplate.find('.actionButtonImg').remove();
            } else {
                buttonTemplate.find('.actionButtonImg').attr('src', scraper.iconClass);
                buttonTemplate.find('.actionButtonIcon').remove();
            }
            buttonTemplate.find('.actionButtonText').text(scraper.name);
            buttonTemplate.attr('title', scraper.description);
            buttonTemplate.on('click', () => {
                const target = modal.attr('data-attachment-manager-target');
                runScraper(scraper.id, target, renderAttachments);
            });
            modal.append(buttonTemplate);
        }

        const modalButtonData = Object.entries(sources).map(entry => {
            const [source, selector] = entry;
            const button = template.find(selector).find('.openActionModalButton').get(0);

            if (!button) {
                return;
            }

            const bodyListener = (e) => {
                if (modal.is(':visible') && (!$(e.target).closest('.openActionModalButton').length)) {
                    modal.hide();
                }

                // Replay a click if the modal was already open by another button
                if ($(e.target).closest('.openActionModalButton').length && !modal.is(':visible')) {
                    modal.show();
                }
            };
            document.body.addEventListener('click', bodyListener);

            const popper = Popper.createPopper(button, modal.get(0), { placement: 'bottom-end' });
            button.addEventListener('click', () => {
                modal.attr('data-attachment-manager-target', source);
                modal.toggle();
                popper.update();
            });

            return { popper, bodyListener };
        }).filter(Boolean);

        return () => {
            modalButtonData.forEach(p => {
                const { popper, bodyListener } = p;
                popper.destroy();
                document.body.removeEventListener('click', bodyListener);
            });
            modal.remove();
        };
    }

    async function renderAttachments() {
        /** @type {FileAttachment[]} */
        const globalAttachments = extension_settings.attachments ?? [];
        /** @type {FileAttachment[]} */
        const chatAttachments = chat_metadata.attachments ?? [];
        /** @type {FileAttachment[]} */
        const characterAttachments = extension_settings.character_attachments?.[characters[this_chid]?.avatar] ?? [];

        await renderList(globalAttachments, ATTACHMENT_SOURCE.GLOBAL);
        await renderList(chatAttachments, ATTACHMENT_SOURCE.CHAT);
        await renderList(characterAttachments, ATTACHMENT_SOURCE.CHARACTER);

        const isNotCharacter = this_chid === undefined || selected_group;
        const isNotInChat = getCurrentChatId() === undefined;
        template.find('.characterAttachmentsBlock').toggle(!isNotCharacter);
        template.find('.chatAttachmentsBlock').toggle(!isNotInChat);

        const characterName = characters[this_chid]?.name || 'Anonymous';
        template.find('.characterAttachmentsName').text(characterName);

        const chatName = getCurrentChatId() || 'Unnamed chat';
        template.find('.chatAttachmentsName').text(chatName);
    }

    const dragDropHandler = new DragAndDropHandler('.popup', async (files, event) => {
        let selectedTarget = ATTACHMENT_SOURCE.GLOBAL;
        const targets = getAvailableTargets();

        const targetSelectTemplate = $(await renderExtensionTemplateAsync('attachments', 'files-dropped', { count: files.length, targets: targets }));
        targetSelectTemplate.find('.droppedFilesTarget').on('input', function () {
            selectedTarget = String($(this).val());
        });
        const result = await callGenericPopup(targetSelectTemplate, POPUP_TYPE.CONFIRM, '', { wide: false, large: false, okButton: 'Upload', cancelButton: 'Cancel' });
        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            console.log('File upload cancelled');
            return;
        }
        for (const file of files) {
            await uploadFileAttachmentToServer(file, selectedTarget);
        }
        renderAttachments();
    });

    let sortField = accountStorage.getItem('DataBank_sortField') || 'created';
    let sortOrder = accountStorage.getItem('DataBank_sortOrder') || 'desc';
    let filterString = '';

    const template = $(await renderExtensionTemplateAsync('attachments', 'manager', {}));

    template.find('.attachmentSearch').on('input', function () {
        filterString = String($(this).val());
        renderAttachments();
    });
    template.find('.attachmentSort').on('change', function () {
        if (!(this instanceof HTMLSelectElement) || this.selectedOptions.length === 0) {
            return;
        }

        sortField = this.selectedOptions[0].dataset.sortField;
        sortOrder = this.selectedOptions[0].dataset.sortOrder;
        accountStorage.setItem('DataBank_sortField', sortField);
        accountStorage.setItem('DataBank_sortOrder', sortOrder);
        renderAttachments();
    });
    function handleBulkAction(action) {
        return async () => {
            const selectedAttachments = document.querySelectorAll('.attachmentListItemCheckboxContainer .attachmentListItemCheckbox:checked');

            if (selectedAttachments.length === 0) {
                toastr.info(t`No attachments selected.`, t`Data Bank`);
                return;
            }

            if (action.confirmMessage) {
                const confirm = await callGenericPopup(action.confirmMessage, POPUP_TYPE.CONFIRM);
                if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
                    return;
                }
            }

            const includeDisabled = true;
            const attachments = getDataBankAttachments(includeDisabled);
            selectedAttachments.forEach(async (checkbox) => {
                const listItem = checkbox.closest('.attachmentListItem');
                if (!(listItem instanceof HTMLElement)) {
                    return;
                }
                const url = listItem.dataset.attachmentUrl;
                const source = listItem.dataset.attachmentSource;
                const attachment = attachments.find(a => a.url === url);
                if (!attachment) {
                    return;
                }
                await action.perform(attachment, source);
            });

            document.querySelectorAll('.attachmentListItemCheckbox, .attachmentsBulkEditCheckbox').forEach(checkbox => {
                if (checkbox instanceof HTMLInputElement) {
                    checkbox.checked = false;
                }
            });

            await renderAttachments();
        };
    }

    template.find('.bulkActionDisable').on('click', handleBulkAction({
        perform: (attachment) => disableAttachment(attachment, () => { }),
    }));

    template.find('.bulkActionEnable').on('click', handleBulkAction({
        perform: (attachment) => enableAttachment(attachment, () => { }),
    }));

    template.find('.bulkActionDelete').on('click', handleBulkAction({
        confirmMessage: 'Are you sure you want to delete the selected attachments?',
        perform: async (attachment, source) => await deleteAttachment(attachment, source, () => { }, false),
    }));

    template.find('.bulkActionSelectAll').on('click', () => {
        $('.attachmentListItemCheckbox:visible').each((_, checkbox) => {
            if (checkbox instanceof HTMLInputElement) {
                checkbox.checked = true;
            }
        });
    });
    template.find('.bulkActionSelectNone').on('click', () => {
        $('.attachmentListItemCheckbox:visible').each((_, checkbox) => {
            if (checkbox instanceof HTMLInputElement) {
                checkbox.checked = false;
            }
        });
    });

    const cleanupFn = await renderButtons();
    await verifyAttachments();
    await renderAttachments();
    await callGenericPopup(template, POPUP_TYPE.TEXT, '', { wide: true, large: true, okButton: 'Close', allowVerticalScrolling: true });

    cleanupFn();
    dragDropHandler.destroy();
}

/**
 * Gets a list of available targets for attachments.
 * @returns {string[]} List of available targets
 */
function getAvailableTargets() {
    const targets = Object.values(ATTACHMENT_SOURCE);

    const isNotCharacter = this_chid === undefined || selected_group;
    const isNotInChat = getCurrentChatId() === undefined;

    if (isNotCharacter) {
        targets.splice(targets.indexOf(ATTACHMENT_SOURCE.CHARACTER), 1);
    }

    if (isNotInChat) {
        targets.splice(targets.indexOf(ATTACHMENT_SOURCE.CHAT), 1);
    }

    return targets;
}

/**
 * Runs a known scraper on a source and saves the result as an attachment.
 * @param {string} scraperId Id of the scraper
 * @param {string} target Target for the attachment
 * @param {function} callback Callback function
 * @returns {Promise<void>} A promise that resolves when the source is scraped.
 */
async function runScraper(scraperId, target, callback) {
    try {
        console.log(`Running scraper ${scraperId} for ${target}`);
        const files = await ScraperManager.runDataBankScraper(scraperId);

        if (!Array.isArray(files)) {
            console.warn('Scraping returned nothing');
            return;
        }

        if (files.length === 0) {
            console.warn('Scraping returned no files');
            toastr.info(t`No files were scraped.`, t`Data Bank`);
            return;
        }

        for (const file of files) {
            await uploadFileAttachmentToServer(file, target);
        }

        toastr.success(t`Scraped ${files.length} files from ${scraperId} to ${target}.`, t`Data Bank`);
        callback();
    }
    catch (error) {
        console.error('Scraping failed', error);
        toastr.error(t`Check browser console for details.`, t`Scraping failed`);
    }
}

/**
 * Uploads a file attachment to the server.
 * @param {File} file File to upload
 * @param {string} target Target for the attachment
 * @returns {Promise<string>} Path to the uploaded file
 */
export async function uploadFileAttachmentToServer(file, target) {
    const isValid = await validateFile(file);

    if (!isValid) {
        return;
    }

    let base64Data = await getBase64Async(file);
    const slug = getStringHash(file.name);
    const uniqueFileName = `${Date.now()}_${slug}.txt`;

    if (isConvertible(file.type)) {
        try {
            const converter = getConverter(file.type);
            const fileText = await converter(file);
            base64Data = convertTextToBase64(fileText);
        } catch (error) {
            toastr.error(String(error), t`Could not convert file`);
            console.error('Could not convert file', error);
        }
    } else {
        const fileText = await file.text();
        base64Data = convertTextToBase64(fileText);
    }

    const fileUrl = await uploadFileAttachment(uniqueFileName, base64Data);
    const convertedSize = Math.round(base64Data.length * 0.75);

    if (!fileUrl) {
        return;
    }

    const attachment = {
        url: fileUrl,
        size: convertedSize,
        name: file.name,
        created: Date.now(),
    };

    ensureAttachmentsExist();

    switch (target) {
        case ATTACHMENT_SOURCE.GLOBAL:
            extension_settings.attachments.push(attachment);
            saveSettingsDebounced();
            break;
        case ATTACHMENT_SOURCE.CHAT:
            chat_metadata.attachments.push(attachment);
            saveMetadataDebounced();
            break;
        case ATTACHMENT_SOURCE.CHARACTER:
            extension_settings.character_attachments[characters[this_chid]?.avatar].push(attachment);
            saveSettingsDebounced();
            break;
    }

    return fileUrl;
}

function ensureAttachmentsExist() {
    if (!Array.isArray(extension_settings.disabled_attachments)) {
        extension_settings.disabled_attachments = [];
    }

    if (!Array.isArray(extension_settings.attachments)) {
        extension_settings.attachments = [];
    }

    if (!Array.isArray(chat_metadata.attachments)) {
        chat_metadata.attachments = [];
    }

    if (this_chid !== undefined && characters[this_chid]) {
        if (!extension_settings.character_attachments) {
            extension_settings.character_attachments = {};
        }

        if (!Array.isArray(extension_settings.character_attachments[characters[this_chid].avatar])) {
            extension_settings.character_attachments[characters[this_chid].avatar] = [];
        }
    }
}

/**
 * Gets all currently available attachments. Ignores disabled attachments by default.
 * @param {boolean} [includeDisabled=false] If true, include disabled attachments
 * @returns {FileAttachment[]} List of attachments
 */
export function getDataBankAttachments(includeDisabled = false) {
    ensureAttachmentsExist();
    const globalAttachments = extension_settings.attachments ?? [];
    const chatAttachments = chat_metadata.attachments ?? [];
    const characterAttachments = extension_settings.character_attachments?.[characters[this_chid]?.avatar] ?? [];

    return [...globalAttachments, ...chatAttachments, ...characterAttachments].filter(x => includeDisabled || !isAttachmentDisabled(x));
}

/**
 * Gets all attachments for a specific source. Includes disabled attachments by default.
 * @param {string} source Attachment source
 * @param {boolean} [includeDisabled=true] If true, include disabled attachments
 * @returns {FileAttachment[]} List of attachments
 */
export function getDataBankAttachmentsForSource(source, includeDisabled = true) {
    ensureAttachmentsExist();

    function getBySource() {
        switch (source) {
            case ATTACHMENT_SOURCE.GLOBAL:
                return extension_settings.attachments ?? [];
            case ATTACHMENT_SOURCE.CHAT:
                return chat_metadata.attachments ?? [];
            case ATTACHMENT_SOURCE.CHARACTER:
                return extension_settings.character_attachments?.[characters[this_chid]?.avatar] ?? [];
        }

        return [];
    }

    return getBySource().filter(x => includeDisabled || !isAttachmentDisabled(x));
}

/**
 * Verifies all attachments in the Data Bank.
 * @returns {Promise<void>} A promise that resolves when attachments are verified.
 */
async function verifyAttachments() {
    for (const source of Object.values(ATTACHMENT_SOURCE)) {
        await verifyAttachmentsForSource(source);
    }
}

/**
 * Verifies all attachments for a specific source.
 * @param {string} source Attachment source
 * @returns {Promise<void>} A promise that resolves when attachments are verified.
 */
async function verifyAttachmentsForSource(source) {
    try {
        const attachments = getDataBankAttachmentsForSource(source);
        const urls = attachments.map(a => a.url);
        const response = await fetch('/api/files/verify', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ urls }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(error);
        }

        const verifiedUrls = await response.json();
        for (const attachment of attachments) {
            if (verifiedUrls[attachment.url] === false) {
                console.log('Deleting orphaned attachment', attachment);
                await deleteAttachment(attachment, source, () => { }, false);
            }
        }
    } catch (error) {
        console.error('Attachment verification failed', error);
    }
}

const NEUTRAL_CHAT_KEY = 'neutralChat';

export function preserveNeutralChat() {
    if (this_chid !== undefined || selected_group || name2 !== neutralCharacterName) {
        return;
    }

    sessionStorage.setItem(NEUTRAL_CHAT_KEY, JSON.stringify({ chat, chat_metadata }));
}

export function restoreNeutralChat() {
    if (this_chid !== undefined || selected_group || name2 !== neutralCharacterName) {
        return;
    }

    const neutralChat = sessionStorage.getItem(NEUTRAL_CHAT_KEY);
    if (!neutralChat) {
        return;
    }

    const { chat: neutralChatData, chat_metadata: neutralChatMetadata } = JSON.parse(neutralChat);
    chat.splice(0, chat.length, ...neutralChatData);
    updateChatMetadata(neutralChatMetadata, true);
    sessionStorage.removeItem(NEUTRAL_CHAT_KEY);
}

/**
 * Registers a file converter function.
 * @param {string} mimeType MIME type
 * @param {ConverterFunction} converter Function to convert file
 * @returns {void}
 */
export function registerFileConverter(mimeType, converter) {
    if (typeof mimeType !== 'string' || typeof converter !== 'function') {
        console.error('Invalid converter registration');
        return;
    }

    if (Object.keys(converters).includes(mimeType)) {
        console.error('Converter already registered');
        return;
    }

    converters[mimeType] = converter;
}

export function addDOMPurifyHooks() {
    // Allow target="_blank" in links
    DOMPurify.addHook('afterSanitizeAttributes', function (node) {
        if ('target' in node) {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener');
        }
    });

    DOMPurify.addHook('uponSanitizeAttribute', (node, data, config) => {
        if (!config['MESSAGE_SANITIZE']) {
            return;
        }

        /* Retain the classes on UI elements of messages that interact with the main UI */
        const permittedNodeTypes = ['BUTTON', 'DIV'];
        if (config['MESSAGE_ALLOW_SYSTEM_UI'] && node.classList.contains('menu_button') && permittedNodeTypes.includes(node.nodeName)) {
            return;
        }

        switch (data.attrName) {
            case 'class': {
                if (data.attrValue) {
                    data.attrValue = data.attrValue.split(' ').map((v) => {
                        if (v.startsWith('fa-') || v.startsWith('note-') || v === 'monospace') {
                            return v;
                        }

                        return 'custom-' + v;
                    }).join(' ');
                }
                break;
            }
        }
    });

    DOMPurify.addHook('uponSanitizeElement', (node, _, config) => {
        if (!config['MESSAGE_SANITIZE']) {
            return;
        }

        // Replace line breaks with <br> in unknown elements
        if (node instanceof HTMLUnknownElement) {
            node.innerHTML = node.innerHTML.trim().replaceAll('\n', '<br>');
        }

        const isMediaAllowed = isExternalMediaAllowed();
        if (isMediaAllowed) {
            return;
        }

        if (!(node instanceof Element)) {
            return;
        }

        let mediaBlocked = false;

        switch (node.tagName) {
            case 'AUDIO':
            case 'VIDEO':
            case 'SOURCE':
            case 'TRACK':
            case 'EMBED':
            case 'OBJECT':
            case 'IMG': {
                const isExternalUrl = (url) => (url.indexOf('://') > 0 || url.indexOf('//') === 0) && !url.startsWith(window.location.origin);
                const src = node.getAttribute('src');
                const data = node.getAttribute('data');
                const srcset = node.getAttribute('srcset');

                if (srcset) {
                    const srcsetUrls = srcset.split(',');

                    for (const srcsetUrl of srcsetUrls) {
                        const [url] = srcsetUrl.trim().split(' ');

                        if (isExternalUrl(url)) {
                            console.warn('External media blocked', url);
                            node.remove();
                            mediaBlocked = true;
                            break;
                        }
                    }
                }

                if (src && isExternalUrl(src)) {
                    console.warn('External media blocked', src);
                    mediaBlocked = true;
                    node.remove();
                }

                if (data && isExternalUrl(data)) {
                    console.warn('External media blocked', data);
                    mediaBlocked = true;
                    node.remove();
                }

                if (mediaBlocked && (node instanceof HTMLMediaElement)) {
                    node.autoplay = false;
                    node.pause();
                }
            }
                break;
        }

        if (mediaBlocked) {
            const entityId = getCurrentEntityId();
            const warningShownKey = `mediaWarningShown:${entityId}`;

            if (accountStorage.getItem(warningShownKey) === null) {
                const warningToast = toastr.warning(
                    t`Use the 'Ext. Media' button to allow it. Click on this message to dismiss.`,
                    t`External media has been blocked`,
                    {
                        timeOut: 0,
                        preventDuplicates: true,
                        onclick: () => toastr.clear(warningToast),
                    },
                );

                accountStorage.setItem(warningShownKey, 'true');
            }
        }
    });
}

export function initChatUtilities() {
    $(document).on('click', '.mes_hide', async function () {
        const messageBlock = $(this).closest('.mes');
        const messageId = Number(messageBlock.attr('mesid'));
        await hideChatMessageRange(messageId, messageId, false);
    });

    $(document).on('click', '.mes_unhide', async function () {
        const messageBlock = $(this).closest('.mes');
        const messageId = Number(messageBlock.attr('mesid'));
        await hideChatMessageRange(messageId, messageId, true);
    });

    $(document).on('click', '.mes_file_delete', async function () {
        const messageBlock = $(this).closest('.mes');
        const messageId = Number(messageBlock.attr('mesid'));
        await deleteMessageFile(messageId);
    });

    $(document).on('click', '.mes_file_open', async function () {
        const messageBlock = $(this).closest('.mes');
        const messageId = Number(messageBlock.attr('mesid'));
        await viewMessageFile(messageId);
    });

    $(document).on('click', '.assistant_note_export', async function () {
        const chatToSave = [
            {
                user_name: name1,
                character_name: name2,
                chat_metadata: chat_metadata,
            },
            ...chat.filter(x => x?.extra?.type !== system_message_types.ASSISTANT_NOTE),
        ];

        download(chatToSave.map((m) => JSON.stringify(m)).join('\n'), `Assistant - ${humanizedDateTime()}.jsonl`, 'application/json');
    });

    $(document).on('click', '.assistant_note_import', async function () {
        const importFile = async () => {
            const file = fileInput.files[0];
            if (!file) {
                return;
            }

            try {
                const text = await getFileText(file);
                const lines = text.split('\n').filter(line => line.trim() !== '');
                const messages = lines.map(line => JSON.parse(line));
                const metadata = messages.shift()?.chat_metadata || {};
                messages.unshift(getSystemMessageByType(system_message_types.ASSISTANT_NOTE));
                await clearChat();
                chat.splice(0, chat.length, ...messages);
                updateChatMetadata(metadata, true);
                await printMessages();
            } catch (error) {
                console.error('Error importing assistant chat:', error);
                toastr.error(t`It's either corrupted or not a valid JSONL file.`, t`Failed to import chat`);
            }
        };
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.jsonl';
        fileInput.addEventListener('change', importFile);
        fileInput.click();
    });

    // Do not change. #attachFile is added by extension.
    $(document).on('click', '#attachFile', function () {
        $('#file_form_input').trigger('click');
    });

    // Do not change. #manageAttachments is added by extension.
    $(document).on('click', '#manageAttachments', function () {
        openAttachmentManager();
    });

    $(document).on('click', '.mes_embed', function () {
        const messageBlock = $(this).closest('.mes');
        const messageId = Number(messageBlock.attr('mesid'));
        embedMessageFile(messageId, messageBlock);
    });

    $(document).on('click', '.editor_maximize', async function () {
        const broId = $(this).attr('data-for');
        const bro = $(`#${broId}`);
        const contentEditable = bro.is('[contenteditable]');
        const withTab = $(this).attr('data-tab');

        if (!bro.length) {
            console.error('Could not find editor with id', broId);
            return;
        }

        const wrapper = document.createElement('div');
        wrapper.classList.add('height100p', 'wide100p', 'flex-container');
        wrapper.classList.add('flexFlowColumn', 'justifyCenter', 'alignitemscenter');
        const textarea = document.createElement('textarea');
        textarea.dataset.for = broId;
        textarea.value = String(contentEditable ? bro[0].innerText : bro.val());
        textarea.classList.add('height100p', 'wide100p', 'maximized_textarea');
        bro.hasClass('monospace') && textarea.classList.add('monospace');
        bro.hasClass('mdHotkeys') && textarea.classList.add('mdHotkeys');
        textarea.addEventListener('input', function () {
            if (contentEditable) {
                bro[0].innerText = textarea.value;
                bro.trigger('input');
            } else {
                bro.val(textarea.value).trigger('input');
            }
        });
        wrapper.appendChild(textarea);

        if (withTab) {
            textarea.addEventListener('keydown', (evt) => {
                if (evt.key == 'Tab' && !evt.shiftKey && !evt.ctrlKey && !evt.altKey) {
                    evt.preventDefault();
                    const start = textarea.selectionStart;
                    const end = textarea.selectionEnd;
                    if (end - start > 0 && textarea.value.substring(start, end).includes('\n')) {
                        const lineStart = textarea.value.lastIndexOf('\n', start);
                        const count = textarea.value.substring(lineStart, end).split('\n').length - 1;
                        textarea.value = `${textarea.value.substring(0, lineStart)}${textarea.value.substring(lineStart, end).replace(/\n/g, '\n\t')}${textarea.value.substring(end)}`;
                        textarea.selectionStart = start + 1;
                        textarea.selectionEnd = end + count;
                    } else {
                        textarea.value = `${textarea.value.substring(0, start)}\t${textarea.value.substring(end)}`;
                        textarea.selectionStart = start + 1;
                        textarea.selectionEnd = end + 1;
                    }
                } else if (evt.key == 'Tab' && evt.shiftKey && !evt.ctrlKey && !evt.altKey) {
                    evt.preventDefault();
                    const start = textarea.selectionStart;
                    const end = textarea.selectionEnd;
                    const lineStart = textarea.value.lastIndexOf('\n', start);
                    const count = textarea.value.substring(lineStart, end).split('\n\t').length - 1;
                    textarea.value = `${textarea.value.substring(0, lineStart)}${textarea.value.substring(lineStart, end).replace(/\n\t/g, '\n')}${textarea.value.substring(end)}`;
                    textarea.selectionStart = start - 1;
                    textarea.selectionEnd = end - count;
                }
            });
        }

        await callGenericPopup(wrapper, POPUP_TYPE.TEXT, '', { wide: true, large: true });
    });

    $(document).on('click', 'body .mes .mes_text', function () {
        if (!power_user.click_to_edit) return;
        if (window.getSelection().toString()) return;
        if ($('.edit_textarea').length) return;
        $(this).closest('.mes').find('.mes_edit').trigger('click');
    });

    $(document).on('click', '.open_media_overrides', openExternalMediaOverridesDialog);
    $(document).on('input', '#forbid_media_override_allowed', function () {
        const entityId = getCurrentEntityId();
        if (!entityId) return;
        power_user.external_media_allowed_overrides.push(entityId);
        power_user.external_media_forbidden_overrides = power_user.external_media_forbidden_overrides.filter((v) => v !== entityId);
        saveSettingsDebounced();
        reloadCurrentChat();
    });
    $(document).on('input', '#forbid_media_override_forbidden', function () {
        const entityId = getCurrentEntityId();
        if (!entityId) return;
        power_user.external_media_forbidden_overrides.push(entityId);
        power_user.external_media_allowed_overrides = power_user.external_media_allowed_overrides.filter((v) => v !== entityId);
        saveSettingsDebounced();
        reloadCurrentChat();
    });
    $(document).on('input', '#forbid_media_override_global', function () {
        const entityId = getCurrentEntityId();
        if (!entityId) return;
        power_user.external_media_allowed_overrides = power_user.external_media_allowed_overrides.filter((v) => v !== entityId);
        power_user.external_media_forbidden_overrides = power_user.external_media_forbidden_overrides.filter((v) => v !== entityId);
        saveSettingsDebounced();
        reloadCurrentChat();
    });

    $('#creators_note_styles_button').on('click', function (e) {
        e.stopPropagation();
        openGlobalStylesPreferenceDialog();
    });

    $(document).on('click', '.mes_img', expandMessageImage);
    $(document).on('click', '.mes_img_enlarge', expandAndZoomMessageImage);
    $(document).on('click', '.mes_img_delete', deleteMessageImage);
    $(document).on('click', '.mes_video_delete', deleteMessageVideo);

    $('#file_form_input').on('change', async () => {
        const fileInput = document.getElementById('file_form_input');
        if (!(fileInput instanceof HTMLInputElement)) return;
        const file = fileInput.files[0];
        await onFileAttach(file);
    });
    $('#file_form').on('reset', function () {
        $('#file_form').addClass('displayNone');
    });

    document.getElementById('send_textarea').addEventListener('paste', async function (event) {
        if (event.clipboardData.files.length === 0) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        const fileInput = document.getElementById('file_form_input');
        if (!(fileInput instanceof HTMLInputElement)) return;

        // Workaround for Firefox: Use a DataTransfer object to indirectly set fileInput.files
        const dataTransfer = new DataTransfer();
        for (let i = 0; i < event.clipboardData.files.length; i++) {
            dataTransfer.items.add(event.clipboardData.files[i]);
        }

        fileInput.files = dataTransfer.files;
        await onFileAttach(fileInput.files[0]);
    });

    eventSource.on(event_types.CHAT_CHANGED, checkForCreatorNotesStyles);
}
