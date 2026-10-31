/**
 * Where the work shops or browses from (C1c). `resolveLocation` turns what the owner said ("Wisconsin",
 * "Madison, WI", "53703", "NYC", "US", "India") into a place: a US ZIP (a state gives its capital's,
 * Wisconsin → 53703 Madison; a big city its own; a ZIP its state by its first three digits) or a
 * country, with coordinates. Site recipes then set it where it changes prices: Amazon's "Deliver to"
 * ZIP (its own dialog, else its address endpoint, then checked on the page), Best Buy's US site
 * (`intl=nosplash`), and the browser's geolocation for every other site, whose prices are national.
 */
import type { BrowserContext, Page } from "playwright-core";

export type Place = {
  kind: "zip" | "city" | "state" | "country";
  /** ISO 3166-1 alpha-2. */
  country: string;
  countryName: string;
  zip?: string;
  city?: string;
  /** The US state's two letters. */
  state?: string;
  lat: number;
  lon: number;
  /** "Madison, WI 53703", "India". */
  label: string;
  note?: string;
};

type State = { name: string; abbr: string; capital: string; zip: string; lat: number; lon: number };

/** Every state and DC, with a ZIP and coordinates in its capital. */
const STATES: readonly State[] = [
  { name: "Alabama", abbr: "AL", capital: "Montgomery", zip: "36104", lat: 32.3792, lon: -86.3077 },
  { name: "Alaska", abbr: "AK", capital: "Juneau", zip: "99801", lat: 58.3019, lon: -134.4197 },
  { name: "Arizona", abbr: "AZ", capital: "Phoenix", zip: "85004", lat: 33.4484, lon: -112.074 },
  { name: "Arkansas", abbr: "AR", capital: "Little Rock", zip: "72201", lat: 34.7465, lon: -92.2896 },
  { name: "California", abbr: "CA", capital: "Sacramento", zip: "95814", lat: 38.5816, lon: -121.4944 },
  { name: "Colorado", abbr: "CO", capital: "Denver", zip: "80202", lat: 39.7392, lon: -104.9903 },
  { name: "Connecticut", abbr: "CT", capital: "Hartford", zip: "06103", lat: 41.7658, lon: -72.6734 },
  { name: "Delaware", abbr: "DE", capital: "Dover", zip: "19901", lat: 39.1582, lon: -75.5244 },
  { name: "District of Columbia", abbr: "DC", capital: "Washington", zip: "20001", lat: 38.9072, lon: -77.0369 },
  { name: "Florida", abbr: "FL", capital: "Tallahassee", zip: "32301", lat: 30.4383, lon: -84.2807 },
  { name: "Georgia", abbr: "GA", capital: "Atlanta", zip: "30303", lat: 33.749, lon: -84.388 },
  { name: "Hawaii", abbr: "HI", capital: "Honolulu", zip: "96813", lat: 21.3069, lon: -157.8583 },
  { name: "Idaho", abbr: "ID", capital: "Boise", zip: "83702", lat: 43.615, lon: -116.2023 },
  { name: "Illinois", abbr: "IL", capital: "Springfield", zip: "62701", lat: 39.7817, lon: -89.6501 },
  { name: "Indiana", abbr: "IN", capital: "Indianapolis", zip: "46204", lat: 39.7684, lon: -86.1581 },
  { name: "Iowa", abbr: "IA", capital: "Des Moines", zip: "50309", lat: 41.5868, lon: -93.625 },
  { name: "Kansas", abbr: "KS", capital: "Topeka", zip: "66603", lat: 39.0473, lon: -95.6752 },
  { name: "Kentucky", abbr: "KY", capital: "Frankfort", zip: "40601", lat: 38.2009, lon: -84.8733 },
  { name: "Louisiana", abbr: "LA", capital: "Baton Rouge", zip: "70802", lat: 30.4515, lon: -91.1871 },
  { name: "Maine", abbr: "ME", capital: "Augusta", zip: "04330", lat: 44.3106, lon: -69.7795 },
  { name: "Maryland", abbr: "MD", capital: "Annapolis", zip: "21401", lat: 38.9784, lon: -76.4922 },
  { name: "Massachusetts", abbr: "MA", capital: "Boston", zip: "02108", lat: 42.3601, lon: -71.0589 },
  { name: "Michigan", abbr: "MI", capital: "Lansing", zip: "48933", lat: 42.7325, lon: -84.5555 },
  { name: "Minnesota", abbr: "MN", capital: "Saint Paul", zip: "55102", lat: 44.9537, lon: -93.09 },
  { name: "Mississippi", abbr: "MS", capital: "Jackson", zip: "39201", lat: 32.2988, lon: -90.1848 },
  { name: "Missouri", abbr: "MO", capital: "Jefferson City", zip: "65101", lat: 38.5767, lon: -92.1735 },
  { name: "Montana", abbr: "MT", capital: "Helena", zip: "59601", lat: 46.5891, lon: -112.0391 },
  { name: "Nebraska", abbr: "NE", capital: "Lincoln", zip: "68508", lat: 40.8136, lon: -96.7026 },
  { name: "Nevada", abbr: "NV", capital: "Carson City", zip: "89701", lat: 39.1638, lon: -119.7674 },
  { name: "New Hampshire", abbr: "NH", capital: "Concord", zip: "03301", lat: 43.2081, lon: -71.5376 },
  { name: "New Jersey", abbr: "NJ", capital: "Trenton", zip: "08608", lat: 40.2206, lon: -74.7597 },
  { name: "New Mexico", abbr: "NM", capital: "Santa Fe", zip: "87501", lat: 35.687, lon: -105.9378 },
  { name: "New York", abbr: "NY", capital: "Albany", zip: "12207", lat: 42.6526, lon: -73.7562 },
  { name: "North Carolina", abbr: "NC", capital: "Raleigh", zip: "27601", lat: 35.7796, lon: -78.6382 },
  { name: "North Dakota", abbr: "ND", capital: "Bismarck", zip: "58501", lat: 46.8083, lon: -100.7837 },
  { name: "Ohio", abbr: "OH", capital: "Columbus", zip: "43215", lat: 39.9612, lon: -82.9988 },
  { name: "Oklahoma", abbr: "OK", capital: "Oklahoma City", zip: "73102", lat: 35.4676, lon: -97.5164 },
  { name: "Oregon", abbr: "OR", capital: "Salem", zip: "97301", lat: 44.9429, lon: -123.0351 },
  { name: "Pennsylvania", abbr: "PA", capital: "Harrisburg", zip: "17101", lat: 40.2732, lon: -76.8867 },
  { name: "Rhode Island", abbr: "RI", capital: "Providence", zip: "02903", lat: 41.824, lon: -71.4128 },
  { name: "South Carolina", abbr: "SC", capital: "Columbia", zip: "29201", lat: 34.0007, lon: -81.0348 },
  { name: "South Dakota", abbr: "SD", capital: "Pierre", zip: "57501", lat: 44.3683, lon: -100.351 },
  { name: "Tennessee", abbr: "TN", capital: "Nashville", zip: "37219", lat: 36.1627, lon: -86.7816 },
  { name: "Texas", abbr: "TX", capital: "Austin", zip: "78701", lat: 30.2672, lon: -97.7431 },
  { name: "Utah", abbr: "UT", capital: "Salt Lake City", zip: "84111", lat: 40.7608, lon: -111.891 },
  { name: "Vermont", abbr: "VT", capital: "Montpelier", zip: "05602", lat: 44.2601, lon: -72.5754 },
  { name: "Virginia", abbr: "VA", capital: "Richmond", zip: "23219", lat: 37.5407, lon: -77.436 },
  { name: "Washington", abbr: "WA", capital: "Olympia", zip: "98501", lat: 47.0379, lon: -122.9007 },
  { name: "West Virginia", abbr: "WV", capital: "Charleston", zip: "25301", lat: 38.3498, lon: -81.6326 },
  { name: "Wisconsin", abbr: "WI", capital: "Madison", zip: "53703", lat: 43.0731, lon: -89.4012 },
  { name: "Wyoming", abbr: "WY", capital: "Cheyenne", zip: "82001", lat: 41.14, lon: -104.8202 },
];

type City = { name: string; state: string; zip: string; lat: number; lon: number; aliases?: string[] };

/** Big US cities and a downtown ZIP each (capitals come from `STATES`). */
const CITIES: readonly City[] = [
  { name: "New York", state: "NY", zip: "10001", lat: 40.7506, lon: -73.9972, aliases: ["nyc", "new york city", "manhattan", "ny city"] },
  { name: "Brooklyn", state: "NY", zip: "11201", lat: 40.6782, lon: -73.9442 },
  { name: "Buffalo", state: "NY", zip: "14202", lat: 42.8864, lon: -78.8784 },
  { name: "Los Angeles", state: "CA", zip: "90012", lat: 34.0522, lon: -118.2437, aliases: ["la", "l.a."] },
  { name: "San Francisco", state: "CA", zip: "94103", lat: 37.7749, lon: -122.4194, aliases: ["sf", "san fran"] },
  { name: "San Diego", state: "CA", zip: "92101", lat: 32.7157, lon: -117.1611 },
  { name: "San Jose", state: "CA", zip: "95113", lat: 37.3382, lon: -121.8863 },
  { name: "Fresno", state: "CA", zip: "93721", lat: 36.7378, lon: -119.7871 },
  { name: "Chicago", state: "IL", zip: "60601", lat: 41.8781, lon: -87.6298 },
  { name: "Houston", state: "TX", zip: "77002", lat: 29.7604, lon: -95.3698 },
  { name: "Dallas", state: "TX", zip: "75201", lat: 32.7767, lon: -96.797 },
  { name: "San Antonio", state: "TX", zip: "78205", lat: 29.4241, lon: -98.4936 },
  { name: "Fort Worth", state: "TX", zip: "76102", lat: 32.7555, lon: -97.3308 },
  { name: "El Paso", state: "TX", zip: "79901", lat: 31.7619, lon: -106.485 },
  { name: "Philadelphia", state: "PA", zip: "19103", lat: 39.9526, lon: -75.1652, aliases: ["philly"] },
  { name: "Pittsburgh", state: "PA", zip: "15222", lat: 40.4406, lon: -79.9959 },
  { name: "Jacksonville", state: "FL", zip: "32202", lat: 30.3322, lon: -81.6557 },
  { name: "Miami", state: "FL", zip: "33130", lat: 25.7617, lon: -80.1918 },
  { name: "Orlando", state: "FL", zip: "32801", lat: 28.5383, lon: -81.3792 },
  { name: "Tampa", state: "FL", zip: "33602", lat: 27.9506, lon: -82.4572 },
  { name: "Charlotte", state: "NC", zip: "28202", lat: 35.2271, lon: -80.8431 },
  { name: "Seattle", state: "WA", zip: "98101", lat: 47.6062, lon: -122.3321 },
  { name: "Detroit", state: "MI", zip: "48226", lat: 42.3314, lon: -83.0458 },
  { name: "Portland", state: "OR", zip: "97204", lat: 45.5152, lon: -122.6784 },
  { name: "Las Vegas", state: "NV", zip: "89101", lat: 36.1699, lon: -115.1398, aliases: ["vegas"] },
  { name: "Memphis", state: "TN", zip: "38103", lat: 35.1495, lon: -90.049 },
  { name: "Louisville", state: "KY", zip: "40202", lat: 38.2527, lon: -85.7585 },
  { name: "Baltimore", state: "MD", zip: "21202", lat: 39.2904, lon: -76.6122 },
  { name: "Milwaukee", state: "WI", zip: "53202", lat: 43.0389, lon: -87.9065 },
  { name: "Green Bay", state: "WI", zip: "54301", lat: 44.5133, lon: -88.0133 },
  { name: "Albuquerque", state: "NM", zip: "87102", lat: 35.0844, lon: -106.6504 },
  { name: "Tucson", state: "AZ", zip: "85701", lat: 32.2226, lon: -110.9747 },
  { name: "Kansas City", state: "MO", zip: "64105", lat: 39.0997, lon: -94.5786 },
  { name: "St. Louis", state: "MO", zip: "63101", lat: 38.627, lon: -90.1994, aliases: ["saint louis", "st louis"] },
  { name: "Minneapolis", state: "MN", zip: "55401", lat: 44.9778, lon: -93.265 },
  { name: "New Orleans", state: "LA", zip: "70112", lat: 29.9511, lon: -90.0715 },
  { name: "Cleveland", state: "OH", zip: "44113", lat: 41.4993, lon: -81.6944 },
  { name: "Cincinnati", state: "OH", zip: "45202", lat: 39.1031, lon: -84.512 },
  { name: "Omaha", state: "NE", zip: "68102", lat: 41.2565, lon: -95.9345 },
  { name: "Newark", state: "NJ", zip: "07102", lat: 40.7357, lon: -74.1724 },
  { name: "Anchorage", state: "AK", zip: "99501", lat: 61.2181, lon: -149.9003 },
  { name: "Charleston", state: "SC", zip: "29401", lat: 32.7765, lon: -79.9311 },
  { name: "Silicon Valley", state: "CA", zip: "94301", lat: 37.4419, lon: -122.143, aliases: ["palo alto", "bay area"] },
  { name: "Cupertino", state: "CA", zip: "95014", lat: 37.323, lon: -122.0322 },
  { name: "Redmond", state: "WA", zip: "98052", lat: 47.674, lon: -122.1215 },
];

type Country = { code: string; name: string; aliases: string[]; lat: number; lon: number; amazon?: string };

/** Countries by name (two letters are US states first: "CA" is California, "Canada" is Canada). */
const COUNTRIES: readonly Country[] = [
  { code: "US", name: "United States", aliases: ["usa", "us", "u.s.", "u.s.a.", "united states of america", "america", "the us", "the usa", "the united states", "states"], lat: 40.7506, lon: -73.9972, amazon: "www.amazon.com" },
  { code: "IN", name: "India", aliases: ["bharat"], lat: 28.6139, lon: 77.209, amazon: "www.amazon.in" },
  { code: "GB", name: "United Kingdom", aliases: ["uk", "u.k.", "great britain", "britain", "england", "scotland", "wales", "the uk"], lat: 51.5074, lon: -0.1278, amazon: "www.amazon.co.uk" },
  { code: "CA", name: "Canada", aliases: [], lat: 43.6532, lon: -79.3832, amazon: "www.amazon.ca" },
  { code: "AU", name: "Australia", aliases: [], lat: -33.8688, lon: 151.2093, amazon: "www.amazon.com.au" },
  { code: "DE", name: "Germany", aliases: ["deutschland"], lat: 52.52, lon: 13.405, amazon: "www.amazon.de" },
  { code: "FR", name: "France", aliases: [], lat: 48.8566, lon: 2.3522, amazon: "www.amazon.fr" },
  { code: "IT", name: "Italy", aliases: ["italia"], lat: 41.9028, lon: 12.4964, amazon: "www.amazon.it" },
  { code: "ES", name: "Spain", aliases: ["españa", "espana"], lat: 40.4168, lon: -3.7038, amazon: "www.amazon.es" },
  { code: "JP", name: "Japan", aliases: [], lat: 35.6762, lon: 139.6503, amazon: "www.amazon.co.jp" },
  { code: "MX", name: "Mexico", aliases: ["méxico"], lat: 19.4326, lon: -99.1332, amazon: "www.amazon.com.mx" },
  { code: "BR", name: "Brazil", aliases: ["brasil"], lat: -23.5505, lon: -46.6333, amazon: "www.amazon.com.br" },
  { code: "NL", name: "Netherlands", aliases: ["holland", "the netherlands"], lat: 52.3676, lon: 4.9041, amazon: "www.amazon.nl" },
  { code: "SE", name: "Sweden", aliases: [], lat: 59.3293, lon: 18.0686, amazon: "www.amazon.se" },
  { code: "PL", name: "Poland", aliases: [], lat: 52.2297, lon: 21.0122, amazon: "www.amazon.pl" },
  { code: "BE", name: "Belgium", aliases: [], lat: 50.8503, lon: 4.3517, amazon: "www.amazon.com.be" },
  { code: "IE", name: "Ireland", aliases: [], lat: 53.3498, lon: -6.2603, amazon: "www.amazon.ie" },
  { code: "SG", name: "Singapore", aliases: [], lat: 1.3521, lon: 103.8198, amazon: "www.amazon.sg" },
  { code: "AE", name: "United Arab Emirates", aliases: ["uae", "dubai", "emirates"], lat: 25.2048, lon: 55.2708, amazon: "www.amazon.ae" },
  { code: "SA", name: "Saudi Arabia", aliases: ["ksa"], lat: 24.7136, lon: 46.6753, amazon: "www.amazon.sa" },
  { code: "TR", name: "Turkey", aliases: ["türkiye", "turkiye"], lat: 41.0082, lon: 28.9784, amazon: "www.amazon.com.tr" },
  { code: "EG", name: "Egypt", aliases: [], lat: 30.0444, lon: 31.2357, amazon: "www.amazon.eg" },
  { code: "CN", name: "China", aliases: [], lat: 39.9042, lon: 116.4074 },
  { code: "KR", name: "South Korea", aliases: ["korea"], lat: 37.5665, lon: 126.978 },
  { code: "CH", name: "Switzerland", aliases: [], lat: 47.3769, lon: 8.5417 },
  { code: "AT", name: "Austria", aliases: [], lat: 48.2082, lon: 16.3738 },
  { code: "DK", name: "Denmark", aliases: [], lat: 55.6761, lon: 12.5683 },
  { code: "NO", name: "Norway", aliases: [], lat: 59.9139, lon: 10.7522 },
  { code: "FI", name: "Finland", aliases: [], lat: 60.1699, lon: 24.9384 },
  { code: "PT", name: "Portugal", aliases: [], lat: 38.7223, lon: -9.1393 },
  { code: "GR", name: "Greece", aliases: [], lat: 37.9838, lon: 23.7275 },
  { code: "NZ", name: "New Zealand", aliases: [], lat: -36.8485, lon: 174.7633 },
  { code: "ZA", name: "South Africa", aliases: [], lat: -26.2041, lon: 28.0473 },
  { code: "NG", name: "Nigeria", aliases: [], lat: 6.5244, lon: 3.3792 },
  { code: "KE", name: "Kenya", aliases: [], lat: -1.2921, lon: 36.8219 },
  { code: "IL", name: "Israel", aliases: [], lat: 32.0853, lon: 34.7818 },
  { code: "ID", name: "Indonesia", aliases: [], lat: -6.2088, lon: 106.8456 },
  { code: "PH", name: "Philippines", aliases: [], lat: 14.5995, lon: 120.9842 },
  { code: "TH", name: "Thailand", aliases: [], lat: 13.7563, lon: 100.5018 },
  { code: "VN", name: "Vietnam", aliases: ["viet nam"], lat: 10.8231, lon: 106.6297 },
  { code: "MY", name: "Malaysia", aliases: [], lat: 3.139, lon: 101.6869 },
  { code: "PK", name: "Pakistan", aliases: [], lat: 24.8607, lon: 67.0011 },
  { code: "BD", name: "Bangladesh", aliases: [], lat: 23.8103, lon: 90.4125 },
  { code: "AR", name: "Argentina", aliases: [], lat: -34.6037, lon: -58.3816 },
  { code: "CL", name: "Chile", aliases: [], lat: -33.4489, lon: -70.6693 },
  { code: "CO", name: "Colombia", aliases: [], lat: 4.711, lon: -74.0721 },
];

/** A US ZIP's state, by its first three digits. */
const ZIP3: ReadonlyArray<[number, number, string]> = [
  [5, 5, "NY"],
  [10, 27, "MA"],
  [28, 29, "RI"],
  [30, 38, "NH"],
  [39, 49, "ME"],
  [50, 59, "VT"],
  [60, 69, "CT"],
  [70, 89, "NJ"],
  [100, 149, "NY"],
  [150, 196, "PA"],
  [197, 199, "DE"],
  [200, 205, "DC"],
  [206, 219, "MD"],
  [220, 246, "VA"],
  [247, 268, "WV"],
  [270, 289, "NC"],
  [290, 299, "SC"],
  [300, 319, "GA"],
  [320, 339, "FL"],
  [341, 349, "FL"],
  [350, 369, "AL"],
  [370, 385, "TN"],
  [386, 397, "MS"],
  [398, 399, "GA"],
  [400, 427, "KY"],
  [430, 459, "OH"],
  [460, 479, "IN"],
  [480, 499, "MI"],
  [500, 528, "IA"],
  [530, 549, "WI"],
  [550, 567, "MN"],
  [569, 569, "DC"],
  [570, 577, "SD"],
  [580, 588, "ND"],
  [590, 599, "MT"],
  [600, 629, "IL"],
  [630, 658, "MO"],
  [660, 679, "KS"],
  [680, 693, "NE"],
  [700, 714, "LA"],
  [716, 729, "AR"],
  [730, 749, "OK"],
  [750, 799, "TX"],
  [800, 816, "CO"],
  [820, 831, "WY"],
  [832, 838, "ID"],
  [840, 847, "UT"],
  [850, 865, "AZ"],
  [870, 884, "NM"],
  [885, 885, "TX"],
  [889, 898, "NV"],
  [900, 961, "CA"],
  [967, 968, "HI"],
  [970, 979, "OR"],
  [980, 994, "WA"],
  [995, 999, "AK"],
];

const norm = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const stateBy = (value: string): State | undefined => {
  const key = norm(value).replace(/\./g, "");
  if (!key) return undefined;
  return STATES.find((state) => state.abbr.toLowerCase() === key || norm(state.name) === key || (key === "washington state" && state.abbr === "WA") || (key === "washington dc" && state.abbr === "DC") || (key === "dc" && state.abbr === "DC"));
};

/** The state a US ZIP is in, or null. */
export function zipState(zip: string): string | null {
  const prefix = Number.parseInt(zip.slice(0, 3), 10);
  if (!/^\d{5}$/.test(zip) || Number.isNaN(prefix)) return null;
  return ZIP3.find(([from, to]) => prefix >= from && prefix <= to)?.[2] ?? null;
}

function us(): Country {
  return COUNTRIES[0]!;
}

function fromState(state: State, city?: string, note?: string): Place {
  return { kind: "state", country: "US", countryName: "United States", zip: state.zip, city: state.capital, state: state.abbr, lat: state.lat, lon: state.lon, label: `${state.capital}, ${state.abbr} ${state.zip}`, ...(city ? { note: `No ZIP is known here for ${city}; ${state.capital}'s ${state.zip} is used.` } : note ? { note } : {}) };
}

function fromCity(city: City): Place {
  return { kind: "city", country: "US", countryName: "United States", zip: city.zip, city: city.name, state: city.state, lat: city.lat, lon: city.lon, label: `${city.name}, ${city.state} ${city.zip}` };
}

function cityBy(name: string, state?: string): City | State | undefined {
  const key = norm(name).replace(/\./g, "");
  const match = (city: City) => norm(city.name).replace(/\./g, "") === key || (city.aliases ?? []).some((alias) => norm(alias).replace(/\./g, "") === key);
  const city = CITIES.find((row) => match(row) && (!state || row.state === state));
  if (city) return city;
  return STATES.find((row) => norm(row.capital) === key && (!state || row.abbr === state));
}

/** A place from what the owner said, or null when it names none. */
export function resolveLocation(input: string): Place | null {
  let text = norm(input)
    .replace(/^(?:in|near|around|at|from|to|for)\s+/, "")
    .replace(/\s*\b(?:area|region|state)$/, "")
    .trim();
  if (!text) return null;
  let saidUs = false;
  const usSuffix = /(?:,|\s)\s*(?:usa|us|u\.s\.?|u\.s\.a\.?|united states(?: of america)?|america)$/;
  if (usSuffix.test(text) && !/^(?:usa|us|u\.s\.?|u\.s\.a\.?|united states(?: of america)?|america)$/.test(text)) {
    text = text.replace(usSuffix, "").trim();
    saidUs = true;
  }
  const zip = /\b(\d{5})(?:-\d{4})?\b/.exec(text)?.[1];
  if (zip) {
    const abbr = zipState(zip);
    const state = abbr ? STATES.find((row) => row.abbr === abbr) : undefined;
    if (state) {
      const city = CITIES.find((row) => row.zip === zip);
      if (city) return { ...fromCity(city), kind: "zip" };
      if (state.zip === zip) return { ...fromState(state), kind: "zip" };
      return { kind: "zip", country: "US", countryName: "United States", zip, state: state.abbr, lat: state.lat, lon: state.lon, label: `ZIP ${zip} (${state.name})` };
    }
  }
  const whole = stateBy(text);
  // Two letters are a US state first ("CA" is California, "IN" is Indiana).
  if (whole && (text.length === 2 || text.replace(/\./g, "").length === 2)) return fromState(whole);
  const country = COUNTRIES.find((row) => norm(row.name) === text || row.aliases.includes(text));
  if (country && !(country.code === "US" && whole)) {
    if (country.code === "US") return { kind: "country", country: "US", countryName: "United States", zip: "10001", city: "New York", state: "NY", lat: country.lat, lon: country.lon, label: "New York, NY 10001", note: "A US ZIP was needed: New York's 10001 is used." };
    return { kind: "country", country: country.code, countryName: country.name, lat: country.lat, lon: country.lon, label: country.name };
  }
  if (whole) return fromState(whole);
  // "Madison, WI", "Madison WI", "Madison, Wisconsin", "Austin Texas".
  const comma = text.split(",").map((part) => part.trim()).filter(Boolean);
  const words = text.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  const tries: Array<[string, string]> = [];
  if (comma.length >= 2) tries.push([comma[0]!, comma[comma.length - 1]!]);
  for (let cut = words.length - 1; cut >= 1; cut -= 1) tries.push([words.slice(0, cut).join(" "), words.slice(cut).join(" ")]);
  for (const [cityName, stateName] of tries) {
    const state = stateBy(stateName);
    if (!state) continue;
    const city = cityBy(cityName, state.abbr);
    if (city) return "capital" in city ? { ...fromState(city), kind: "city" } : fromCity(city);
    return { ...fromState(state, titleCase(cityName)), kind: "city", label: `${titleCase(cityName)}, ${state.abbr} (ZIP ${state.zip})` };
  }
  const city = cityBy(text);
  if (city) return "capital" in city ? { ...fromState(city), kind: "city" } : fromCity(city);
  if (saidUs) return { kind: "country", country: "US", countryName: "United States", zip: "10001", city: "New York", state: "NY", lat: us().lat, lon: us().lon, label: "New York, NY 10001", note: `“${input.trim()}” is not a place known here; New York's 10001 is used.` };
  return null;
}

function titleCase(text: string): string {
  return text.replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

/** Amazon's site for a country (amazon.in for India), else null. */
export function amazonHostFor(country: string): string | null {
  return COUNTRIES.find((row) => row.code === country)?.amazon ?? null;
}

// ── setting it on a site ────────────────────────────────────────────────────

export type LocationSet = { ok: boolean; shown: string; how: string; note?: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The browser's own location for every page of this context: geolocation and its permission for the site. */
export async function setGeolocation(context: BrowserContext, place: Place, origin?: string): Promise<void> {
  await context.setGeolocation({ latitude: place.lat, longitude: place.lon, accuracy: 100 }).catch(() => undefined);
  if (origin) await context.grantPermissions(["geolocation"], { origin }).catch(() => undefined);
}

export function isAmazon(url: string): boolean {
  try {
    return /(^|\.)amazon\.(?:com|ca|co\.uk|de|fr|it|es|in|co\.jp|com\.mx|com\.br|com\.au|nl|se|pl|sg|ae|sa|com\.tr|eg|com\.be|ie)$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function isBestBuy(url: string): boolean {
  try {
    return /(^|\.)bestbuy\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Best Buy's US site without its country picker. */
export function bestBuyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)bestbuy\.com$/i.test(parsed.hostname)) return url;
    parsed.searchParams.set("intl", "nosplash");
    return parsed.toString();
  } catch {
    return url;
  }
}

/** What Amazon's header says it delivers to ("Madison 53703"). */
export async function amazonShown(page: Page): Promise<string> {
  const line = await page.locator("#glow-ingress-line2").first().innerText({ timeout: 1_500 }).catch(() => "");
  return line.replace(/[\s\u200b-\u200f]+/g, " ").trim();
}

/** Amazon's "Deliver to" ZIP through its own dialog. */
async function amazonZipByDialog(page: Page, zip: string, deadline: number): Promise<boolean> {
  const left = () => Math.max(500, deadline - Date.now());
  const opener = page.locator("#nav-global-location-popover-link, #glow-ingress-block, .glow-toaster input[data-action-type='SELECT_LOCATION']").filter({ visible: true }).first();
  if (!(await opener.count().catch(() => 0))) return false;
  await opener.click({ timeout: Math.min(5_000, left()) });
  const input = page.locator("#GLUXZipUpdateInput").filter({ visible: true }).first();
  await input.waitFor({ state: "visible", timeout: Math.min(10_000, left()) });
  await input.fill(zip, { timeout: Math.min(5_000, left()) });
  await page.locator("#GLUXZipUpdate input, #GLUXZipUpdate .a-button-input").filter({ visible: true }).first().click({ timeout: Math.min(5_000, left()) });
  // Amazon confirms with "Continue" (or "Done"), or closes the dialog and reloads by itself.
  for (let waited = 0; waited < 6_000 && Date.now() < deadline; waited += 300) {
    const confirm = page.locator("#GLUXConfirmClose, [name='glowDoneButton'], .a-popover-footer #GLUXConfirmClose").filter({ visible: true }).first();
    if (await confirm.count().catch(() => 0)) {
      await confirm.click({ timeout: Math.min(3_000, left()) }).catch(() => undefined);
      break;
    }
    if (!(await page.locator("#GLUXZipUpdateInput").filter({ visible: true }).count().catch(() => 0))) break;
    await sleep(300);
  }
  await page.waitForLoadState("domcontentloaded", { timeout: Math.min(5_000, left()) }).catch(() => undefined);
  return true;
}

/** Amazon's "Deliver to" ZIP through the endpoint its dialog calls, with this context's cookies. */
async function amazonZipByEndpoint(page: Page, zip: string): Promise<boolean> {
  const origin = new URL(page.url()).origin;
  const html = await page.content().catch(() => "");
  const modal = /anti-csrftoken-a2z&quot;:&quot;([^&]+)&quot;/.exec(html)?.[1] ?? /"anti-csrftoken-a2z"\s*:\s*"([^"]+)"/.exec(html)?.[1];
  if (!modal) return false;
  const request = page.context().request;
  const selections = await request.get(`${origin}/portal-migration/hz/glow/get-rendered-address-selections?deviceType=desktop&pageType=Search&storeContext=NoStoreName&actionSource=desktop-modal`, { headers: { "anti-csrftoken-a2z": modal }, timeout: 10_000 }).catch(() => null);
  const body = selections?.ok() ? await selections.text().catch(() => "") : "";
  const token = /CSRF_TOKEN\s*:\s*"([^"]+)"/.exec(body)?.[1];
  if (!token) return false;
  const changed = await request
    .post(`${origin}/portal-migration/hz/glow/address-change?actionSource=glow`, {
      headers: { "anti-csrftoken-a2z": token, "content-type": "application/json" },
      data: JSON.stringify({ locationType: "LOCATION_INPUT", zipCode: zip, deviceType: "web", storeContext: "generic", pageType: "Search", actionSource: "glow" }),
      timeout: 10_000,
    })
    .catch(() => null);
  return Boolean(changed?.ok());
}

/**
 * Sets Amazon's "Deliver to" ZIP on this tab (US sites take a ZIP; amazon.com from abroad shows
 * "Deliver to India" and no prices until it has one), then reloads and reads it back.
 */
export async function setAmazonLocation(page: Page, place: Place, options: { timeoutMs?: number } = {}): Promise<LocationSet> {
  const deadline = Date.now() + (options.timeoutMs ?? 25_000);
  const before = await amazonShown(page);
  if (!place.zip) return { ok: false, shown: before, how: "none", note: "Amazon's US site needs a US ZIP; for another country use that country's Amazon site." };
  if (before.includes(place.zip)) return { ok: true, shown: before, how: "already" };
  let how = "dialog";
  try {
    await amazonZipByDialog(page, place.zip, deadline);
  } catch {
    how = "failed";
  }
  await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
  let shown = await amazonShown(page);
  if (!shown.includes(place.zip) && Date.now() < deadline) {
    how = (await amazonZipByEndpoint(page, place.zip).catch(() => false)) ? "endpoint" : how;
    await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
    shown = await amazonShown(page);
  }
  const ok = shown.includes(place.zip);
  return { ok, shown, how, ...(ok ? {} : { note: `Amazon still shows “${shown || "no delivery place"}”, so its prices may be for another place.` }) };
}

/** Sets the place for a tab's site: Amazon's ZIP, Best Buy's US site, else the browser's geolocation. */
export async function setSiteLocation(page: Page, place: Place, options: { timeoutMs?: number } = {}): Promise<LocationSet & { site: string }> {
  let origin: string | undefined;
  try {
    origin = new URL(page.url()).origin;
  } catch {
    origin = undefined;
  }
  await setGeolocation(page.context(), place, origin);
  if (isAmazon(page.url())) return { ...(await setAmazonLocation(page, place, options)), site: "amazon" };
  if (isBestBuy(page.url()) && place.country === "US") {
    if (!/[?&]intl=nosplash\b/.test(page.url())) await page.goto(bestBuyUrl(page.url()), { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
    const usLink = page.locator("a.us-link, .country-selection a[href*='bestbuy.com']").filter({ visible: true }).first();
    if (await usLink.count().catch(() => 0)) await usLink.click({ timeout: 5_000 }).catch(() => undefined);
    return { ok: true, shown: "Best Buy US site", how: "us-site", site: "bestbuy", note: "Best Buy shows national online prices; store stock near the ZIP is not checked." };
  }
  return { ok: true, shown: "", how: "geolocation", site: origin ? new URL(origin).hostname : "", note: "Only the browser's location is set: this site's prices are its national online prices." };
}
