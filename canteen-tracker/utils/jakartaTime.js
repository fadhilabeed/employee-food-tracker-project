const APP_TIME_ZONE = "Asia/Jakarta";

const dateTimeFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  hourCycle: "h23"
});

function getJakartaDateTimeParts(date = new Date()) {
  const values = {};

  for (const part of dateTimeFormatter.formatToParts(date)) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  const hour = Number(values.hour) % 24;

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour,
    minute: values.minute,
    second: values.second
  };
}

function getJakartaNow(date = new Date()) {
  const parts = getJakartaDateTimeParts(date);
  const mealDate = `${parts.year}-${parts.month}-${parts.day}`;
  const scannedAt = `${mealDate} ${String(parts.hour).padStart(2, "0")}:${parts.minute}:${parts.second}`;

  return {
    ...parts,
    mealDate,
    scannedAt
  };
}

function getJakartaCurrentDate(date = new Date()) {
  return getJakartaNow(date).mealDate;
}

function getMealCategory(hour) {
  if (hour >= 7 && hour < 9) return "breakfast";
  if (hour >= 11 && hour < 14) return "lunch";
  if (hour >= 17 && hour < 19) return "dinner";
  if (hour >= 23 || hour < 2) return "supper";
  return "outside";
}

module.exports = {
  APP_TIME_ZONE,
  getJakartaCurrentDate,
  getJakartaNow,
  getMealCategory
};
