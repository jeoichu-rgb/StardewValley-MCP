using System;
using System.Collections.Generic;
using StardewValley;

namespace StardewMCPBridge
{
    /// <summary>
    /// In-memory queue of player→companion interaction events (talks, gifts).
    /// Written into bridge_data.json each sync so the MCP side can see when
    /// the player clicks a companion and respond with stardew_speak.
    /// Events carry a monotonic id; consumers track the last id they've seen.
    /// </summary>
    public static class BridgeEvents
    {
        private const int MaxEvents = 20;
        private static readonly List<object> events = new List<object>();
        private static int nextId = 1;

        public static void Queue(string type, string companion, Dictionary<string, object> payload = null)
        {
            var evt = new Dictionary<string, object>
            {
                ["id"] = nextId++,
                ["type"] = type,
                ["companion"] = companion,
                ["gameTime"] = Game1.timeOfDay,
                ["day"] = Game1.dayOfMonth,
                ["season"] = Game1.currentSeason,
                ["at"] = DateTime.UtcNow.ToString("o"),
            };
            if (payload != null)
                foreach (var kv in payload)
                    evt[kv.Key] = kv.Value;

            events.Add(evt);
            if (events.Count > MaxEvents)
                events.RemoveRange(0, events.Count - MaxEvents);
        }

        /// <summary>Recent events, oldest first.</summary>
        public static List<object> Snapshot() => new List<object>(events);

        public static void Clear() => events.Clear();
    }
}
