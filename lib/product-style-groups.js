function cleanText(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

function normalizedKey(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function handleForName(value) {
  return normalizedKey(value).replace(/\s+/g, "-").slice(0, 255);
}

module.exports = {
  cleanText,
  handleForName,
  normalizedKey
};
