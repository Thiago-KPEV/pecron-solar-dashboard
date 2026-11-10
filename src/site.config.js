/*
 * site.config.js - structured, site-specific settings.
 *
 * Simple values (site name, timezone, panel watts, battery size, grid rate and
 * so on) live in the [vars] block of wrangler.toml. This file holds the things
 * that are awkward to express as a flat string. It is bundled into the Worker,
 * so redeploy (`npx wrangler deploy`) after changing it.
 *
 * Nothing in here is secret. Do not put credentials in this file.
 * Every field is described in docs/CONFIGURATION.md.
 */
export default {
  /*
   * Vehicles (PEVs: e-bikes, scooters, skateboards...) that charge from this
   * system. They are listed on the dashboard and returned by /api/summary.
   *
   * The FIRST entry drives the "miles on sunlight" and "commutes banked"
   * figures: harvest x chargeEfficiency / whPerMile, and miles / commuteMiles.
   * Use an empty array to hide the vehicle card; mile figures then read null.
   *
   * Any field may be null. The example below is fictional - replace it.
   */
  pevs: [
    {
      name: "Example E-Bike",
      type: "electric bike",
      role: "daily commuter",
      pack: "13s4p example pack",
      cells: 52,
      capacityWh: 720,
      capacityAh: 14,
      voltsNominal: 48,
      voltsFull: 54.6,
      motor: null,
      controller: null,
      whPerMile: 25,                 // measure your own: Wh used / miles ridden
      whPerMileSource: "example value - replace with your own measurement",
      charger: "Example 2 A charger",
      chargerWatts: 110,
      chargerAmps: 2,
      commuteMiles: 20,              // one round trip, in miles
      blogUrl: null,                 // optional link shown as "More ->"
    },
  ],

  // Fraction of battery energy that reaches the vehicle's pack after charger
  // and inverter losses. An estimate; 0.85 is a reasonable default.
  chargeEfficiency: 0.85,

  // Rated cycle life of the station's battery, for the "pack life used" tile.
  // LiFePO4 is typically rated around 3,500 cycles - check your unit's spec.
  ratedCycles: 3500,

  // Optional: typical peak sun hours for your region, shown next to your own
  // figure for comparison. null hides it.
  peakSunHoursNorm: null,

  // Optional: grid emissions factor in kg CO2e per kWh, used only on /mockups.
  // Look up your grid's published figure. null hides the estimate.
  gridCo2KgPerKwh: null,
};
