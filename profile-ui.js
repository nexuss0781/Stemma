/* Pure classic-script renderer for the student profile page. */
function renderStudentProfile(profile, options = {}) {
  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function textField(source, key, preserveWhitespace) {
    const value = source && typeof source[key] === 'string' ? source[key] : '';
    if (!value.trim()) return 'Not provided';
    return preserveWhitespace ? value : value.trim();
  }

  function section(title, fields) {
    return `<section class='student-profile-section'><h2>${title}</h2><dl class='student-profile-details'>${fields.map(([label, value, isBio]) => {
      const rowClass = isBio ? 'student-profile-detail profile-bio' : 'student-profile-detail';
      return `<div class='${rowClass}'><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`;
    }).join('')}</dl></section>`;
  }

  function statePage(message, buttonLabel, buttonAttribute, busy) {
    const busyAttribute = busy ? " aria-busy='true'" : '';
    const button = buttonLabel
      ? `<button type='button' ${buttonAttribute}>${buttonLabel}</button>`
      : '';
    return `<article class='student-profile-page'${busyAttribute}><div class='student-profile-empty-card'><p>${message}</p>${button}</div></article>`;
  }

  const settings = options && typeof options === 'object' ? options : {};
  const state = settings.state || 'ready';

  if (state === 'loading') {
    return statePage('Loading your profile…', '', '', true);
  }
  if (state === 'error') {
    return statePage('Your saved profile could not be loaded.', 'Try again', 'data-retry-profile', false);
  }
  if (state === 'guest' || !profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return statePage('Your profile is not set up yet.', 'Set up profile', 'data-setup-profile', false);
  }

  const values = {
    firstName: textField(profile, 'firstName', false),
    middleName: textField(profile, 'middleName', false),
    lastName: textField(profile, 'lastName', false),
    studentId: textField(profile, 'studentId', false),
    department: textField(profile, 'department', false),
    nickName: textField(profile, 'nickName', false),
    username: textField(profile, 'username', false),
    bio: textField(profile, 'bio', true)
  };

  const fullName = [profile.firstName, profile.middleName, profile.lastName]
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => value.trim())
    .join(' ');
  const displayName = values.nickName !== 'Not provided' ? values.nickName : fullName;
  const showFullName = values.nickName !== 'Not provided' && fullName && fullName !== values.nickName;
  const photoURL = typeof settings.photoURL === 'string' && settings.photoURL.startsWith('blob:')
    ? settings.photoURL
    : '';
  const avatarContent = photoURL
    ? `<img id='profile-photo-image' src='${escapeHtml(photoURL)}' alt=''>`
    : `<span class='student-profile-avatar-fallback' aria-hidden='true'><svg viewBox='0 0 32 32' aria-hidden='true'><circle cx='16' cy='11' r='5'/><path d='M6 28v-3a10 10 0 0 1 20 0v3'/></svg></span>`;
  const avatar = `<button type='button' class='student-profile-avatar' data-profile-photo aria-label='${photoURL ? 'Replace profile photo' : 'Choose profile photo'}'>${avatarContent}<span class='student-profile-camera' aria-hidden='true'><svg viewBox='0 0 24 24' focusable='false' aria-hidden='true'><path d='M8.2 4 6.7 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-2.7L15.8 4zM12 8a5 5 0 1 1 0 10 5 5 0 0 1 0-10m0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6'></path></svg></span></button>`;
  const notice = typeof settings.photoNotice === 'string' && settings.photoNotice
    ? `<p class='student-profile-notice' role='status'>${escapeHtml(settings.photoNotice)}</p>`
    : '';
  const nameHeading = displayName
    ? `<h1 id='student-profile-display-name' class='student-profile-name'>${escapeHtml(displayName)}</h1>`
    : '';
  const secondaryName = showFullName
    ? `<p class='student-profile-full-name'>${escapeHtml(fullName)}</p>`
    : '';
  const handle = values.username !== 'Not provided'
    ? `<p class='student-profile-handle'>@${escapeHtml(values.username)}</p>`
    : '';

  return `<article class='student-profile-page'><header class='student-profile-header'>${avatar}${nameHeading}${secondaryName}${handle}${notice}</header>${section('Identity', [
    ['First name', values.firstName],
    ['Middle name', values.middleName],
    ['Last name', values.lastName]
  ])}${section('Student details', [
    ['Student ID', values.studentId],
    ['Department', values.department]
  ])}${section('Account &amp; about', [
    ['Nick Name', values.nickName],
    ['Username', values.username],
    ['Signed-in email', typeof settings.email === 'string' && settings.email.trim() ? settings.email.trim() : 'Not available'],
    ['Bio', values.bio, true]
  ])}</article>`;
}
