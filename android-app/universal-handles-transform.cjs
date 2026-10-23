'use strict';

const CHANNEL_USERNAME_PATTERN = /^[A-Za-z0-9_.]{5,30}$/;
const GROUP_SLUG_PATTERN = /^[A-Za-z0-9_-]{5,40}$/;

function replaceOnce(code, needle, replacement, label) {
  const first = code.indexOf(needle);
  if (first < 0 || code.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`Android universal handles transform anchor missing or ambiguous: ${label}`);
  }
  return code.slice(0, first) + replacement + code.slice(first + needle.length);
}

function transformChannels(code) {
  code = replaceOnce(
    code,
    '<h2 data-channel-name tabindex="-1"></h2>',
    '<h2 data-channel-name tabindex="-1"></h2><p class="channel-universal-handle" data-channel-handle hidden></p>',
    'channel handle header'
  );
  code = replaceOnce(
    code,
    '<label class="group-name-field">Channel name<input name="name" maxlength="80" required autocomplete="off" placeholder="Enter channel name"></label>',
    '<label class="group-name-field">Channel name<input name="name" maxlength="80" required autocomplete="off" placeholder="Enter channel name"></label><label class="group-name-field">Channel username<input name="username" minlength="5" maxlength="30" pattern="[A-Za-z0-9_.]{5,30}" required autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="username" aria-describedby="channel-username-help"></label><small id="channel-username-help" class="channel-username-help">Choose a unique 5–30 character handle using letters, numbers, underscores, or periods. Usernames are case-insensitive.</small>',
    'channel username input'
  );
  code = replaceOnce(
    code,
    "view.querySelector('[data-channel-name]').textContent = current.name;",
    "view.querySelector('[data-channel-name]').textContent = current.name;\n      const channelHandle = view.querySelector('[data-channel-handle]');\n      const channelUsername = typeof current.username === 'string' ? current.username.trim() : '';\n      channelHandle.textContent = channelUsername ? `@${channelUsername}` : '';\n      channelHandle.hidden = !channelUsername;",
    'channel handle display'
  );
  code = replaceOnce(
    code,
    "const name = createForm.elements.name.value.trim(); if (!name) { createForm.elements.name.focus(); return; }",
    "const name = createForm.elements.name.value.trim(); if (!name) { createForm.elements.name.focus(); return; }\n      const username = createForm.elements.username.value.trim().toLowerCase();\n      if (!/^[A-Za-z0-9_.]{5,30}$/.test(username)) { createForm.querySelector('[data-channel-create-status]').textContent = 'Use 5–30 letters, numbers, underscores or periods for the channel username.'; createForm.elements.username.focus(); return; }",
    'channel username validation and error'
  );
  return replaceOnce(
    code,
    'body: JSON.stringify({ name }) }); if (!signal.aborted)',
    'body: JSON.stringify({ name, username }) }); if (!signal.aborted)',
    'channel username payload'
  );
}

function transformGroups(code) {
  code = replaceOnce(
    code,
    '<input id="group-public-username" name="slug" maxlength="40" required autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="username" aria-describedby="group-link-availability">',
    '<input id="group-public-username" name="slug" minlength="5" maxlength="40" pattern="[A-Za-z0-9_-]{5,40}" required autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="username" aria-describedby="group-link-availability">',
    'group public username input constraints'
  );
  code = replaceOnce(
    code,
    "if (!/^[a-z0-9_-]{3,40}$/.test(slug)) { availability.textContent = 'Use 3–40 letters, numbers, underscores or hyphens.'; availability.dataset.state = 'error'; return false; }",
    "if (!/^[a-z0-9_-]{5,40}$/.test(slug)) { availability.textContent = 'Use 5–40 letters, numbers, underscores or hyphens.'; availability.dataset.state = 'error'; return false; }",
    'group public username availability validation'
  );
  code = replaceOnce(code, 'slug === current?.slug', "slug === String(current?.slug || '').toLowerCase()", 'case-insensitive current group username');
  code = replaceOnce(code, 'payload.slug = form.elements.slug.value.trim();', 'payload.slug = form.elements.slug.value.trim().toLowerCase();', 'lowercase group username payload');
  code = replaceOnce(
    code,
    '<span class="group-conversation-title" data-conversation-name></span>',
    '<span class="group-conversation-title" data-conversation-name></span><small class="group-universal-handle" data-conversation-handle hidden></small>',
    'group conversation handle element'
  );
  code = replaceOnce(
    code,
    '<h2 data-group-name tabindex="-1"></h2>',
    '<h2 data-group-name tabindex="-1"></h2><p class="group-universal-handle" data-group-handle hidden></p>',
    'group detail handle element'
  );
  code = replaceOnce(
    code,
    "detail.querySelector('[data-group-name]').textContent = group.name || 'Group';",
    "detail.querySelector('[data-group-name]').textContent = group.name || 'Group';\n      const groupHandle = group.visibility === 'public' && typeof group.slug === 'string' ? group.slug.trim() : '';\n      const detailHandle = detail.querySelector('[data-group-handle]');\n      detailHandle.textContent = groupHandle ? `@${groupHandle}` : '';\n      detailHandle.hidden = !groupHandle;",
    'group detail handle display'
  );
  code = replaceOnce(
    code,
    "detail.querySelector('[data-conversation-name]').textContent = group.name || 'Group';",
    "detail.querySelector('[data-conversation-name]').textContent = group.name || 'Group';\n      const conversationHandle = detail.querySelector('[data-conversation-handle]');\n      conversationHandle.textContent = groupHandle ? `@${groupHandle}` : '';\n      conversationHandle.hidden = !groupHandle;",
    'group conversation handle display'
  );
  return replaceOnce(code, '/^[a-z0-9_-]{5,40}$/.test(slug)', '/^[A-Za-z0-9_-]{5,40}$/.test(slug)', 'group handle validation');
}

function transformAccountEditor(code) {
  code = replaceOnce(code, '/^[A-Za-z0-9_.]{3,30}$/.test(profile.username)', '/^[A-Za-z0-9_.]{5,30}$/.test(profile.username)', 'account username completion minimum');
  code = replaceOnce(code, '/^[A-Za-z0-9_.]{3,30}$/.test(username.value.trim())', '/^[A-Za-z0-9_.]{5,30}$/.test(username.value.trim())', 'account username editor minimum');
  return replaceOnce(
    code,
    "profile[name] = personalizationForm.elements.namedItem(name).value.trim();",
    "profile[name] = personalizationForm.elements.namedItem(name).value.trim();\n    if (name === 'username') profile[name] = profile[name].toLowerCase();",
    'lowercase account username payload'
  );
}

function transformProfile(code) {
  code = replaceOnce(
    code,
    "  const handle = values.username !== 'Not provided'\n    ? `<p class='student-profile-handle'>@${escapeHtml(values.username)}</p>`\n    : '';",
    "  const handle = values.username !== 'Not provided'\n    ? `<p class='student-profile-handle'>@${escapeHtml(values.username)}</p>`\n    : '';\n  const universalHandleNote = `<p class='student-profile-handle-note'>Your username is your universal handle across accounts, groups, channels, and apps.</p>`;",
    'profile universal handle note'
  );
  return replaceOnce(code, '${secondaryName}${handle}${notice}', '${secondaryName}${handle}${universalHandleNote}${notice}', 'profile universal handle placement');
}

function transformSource(file, code) {
  if (file === '/channels-ui.js') return transformChannels(code);
  if (file === '/groups-ui.js') return transformGroups(code);
  if (file === '/profile-ui.js') return transformProfile(code);
  if (file === '/app.js') return transformAccountEditor(code);
  return code;
}

module.exports = {
  CHANNEL_USERNAME_PATTERN,
  GROUP_SLUG_PATTERN,
  transformSource,
  transformChannels,
  transformGroups,
  transformAccountEditor,
  transformProfile
};
