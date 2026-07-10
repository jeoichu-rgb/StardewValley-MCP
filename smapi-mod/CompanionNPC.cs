using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using StardewValley;

namespace StardewMCPBridge
{
    /// <summary>
    /// NPC subclass that corrects the sprite aspect ratio.
    /// Vanilla NPC.draw() uses a uniform float scale, which makes custom
    /// companion sprites look narrower than the multi-layered Farmer sprite.
    /// This override uses Vector2 scale to widen the sprite slightly.
    /// </summary>
    public class CompanionNPC : NPC
    {
        // FarmSplitter-generated sheets are pixel-perfect FarmerRenderer output;
        // no width compensation needed (1.3 was for hand-drawn legacy sprites).
        public float WidthScale { get; set; } = 1.0f;

        public CompanionNPC(AnimatedSprite sprite, Vector2 position, string defaultMap,
            int facingDir, string name, Texture2D portrait, bool eventActor)
            : base(sprite, position, defaultMap, facingDir, name, portrait, eventActor)
        {
        }

        /// <summary>
        /// Player right-clicked us. Vanilla checkAction dead-ends for us (no schedule,
        /// empty dialogue stack), so take over: route gifts through the vanilla
        /// friendship pipeline, show any dialogue the MCP side queued via "speak",
        /// and report every interaction to the bridge so the real companion can answer.
        /// </summary>
        public override bool checkAction(Farmer who, GameLocation l)
        {
            if (who == null || Game1.eventUp)
                return false;

            // The friendship table only knows NPCs the game introduced itself;
            // we spawned outside that flow, so register the relationship lazily.
            if (!who.friendshipData.ContainsKey(Name))
                who.friendshipData.Add(Name, new Friendship(0));

            // Gift flow — vanilla handles taste lookup, points, bouquet/pendant
            // dating logic, and the reaction text from Data/NPCGiftTastes.
            if (who.ActiveObject != null && who.ActiveObject.canBeGivenAsGift())
            {
                var gift = who.ActiveObject;
                string giftName = gift.DisplayName ?? gift.Name;
                string qid = gift.QualifiedItemId;
                int taste = 8;
                try { taste = this.getGiftTasteForThisItem(gift); } catch { }

                bool received = this.tryToReceiveActiveObject(who);
                if (received)
                {
                    var friendship = who.friendshipData[Name];
                    string kind = qid == "(O)458" ? "bouquet"
                        : qid == "(O)460" ? "proposal"
                        : "gift";
                    BridgeEvents.Queue(kind, Name, new Dictionary<string, object>
                    {
                        ["item"] = giftName,
                        ["qualifiedId"] = qid,
                        ["taste"] = taste switch { 0 => "love", 2 => "like", 4 => "dislike", 6 => "hate", _ => "neutral" },
                        ["friendshipPoints"] = friendship.Points,
                        ["hearts"] = friendship.Points / 250,
                        ["relationship"] = friendship.Status.ToString(),
                    });
                    this.faceTowardFarmerForPeriod(3000, 4, false, who);
                }
                return true;
            }

            // Plain talk: face her. If the MCP side staged dialogue, play it now;
            // otherwise emote and let the bridge carry the moment upstream.
            this.faceGeneralDirection(who.getStandingPosition(), 0, false, false);
            this.grantConversationFriendship(who); // vanilla daily "talked to" +20, once per day

            if (this.CurrentDialogue.Count > 0)
            {
                Game1.DrawDialogue(this.CurrentDialogue.Pop());
                return true;
            }

            this.doEmote(20); // heart
            BridgeEvents.Queue("talk", Name, new Dictionary<string, object>
            {
                ["heldItem"] = who.ActiveObject?.DisplayName,
                ["location"] = l?.Name ?? this.currentLocation?.Name,
                ["playerTile"] = new { x = (int)who.Tile.X, y = (int)who.Tile.Y },
            });
            return true;
        }

        public override void draw(SpriteBatch b, float alpha = 1f)
        {
            if (Sprite?.Texture == null || IsInvisible) return;

            float baseScale = Math.Max(0.2f, scale.Value) * 4f;
            Vector2 drawScale = new Vector2(baseScale * WidthScale, baseScale);

            Vector2 localPos = getLocalPosition(Game1.viewport);
            float widthOffset = GetSpriteWidthForPositioning() * 4 / 2;
            float heightOffset = GetBoundingBox().Height / 2;

            Vector2 screenPos = localPos + new Vector2(widthOffset, heightOffset);
            Vector2 origin = new Vector2(
                Sprite.SpriteWidth / 2f,
                Sprite.SpriteHeight * 3f / 4f
            );

            float layerDepth = Math.Max(0f,
                drawOnTop ? 0.991f : (float)StandingPixel.Y / 10000f);

            SpriteEffects effects = flip ||
                (Sprite.CurrentAnimation != null &&
                 Sprite.currentAnimationIndex < Sprite.CurrentAnimation.Count &&
                 Sprite.CurrentAnimation[Sprite.currentAnimationIndex].flip)
                ? SpriteEffects.FlipHorizontally
                : SpriteEffects.None;

            b.Draw(
                Sprite.Texture,
                screenPos,
                Sprite.SourceRect,
                Color.White * alpha,
                0f,
                origin,
                drawScale,
                effects,
                layerDepth
            );

            // Emote bubble (reuse vanilla logic position)
            if (isEmoting && !Game1.eventUp)
            {
                Vector2 emotePos = getLocalPosition(Game1.viewport);
                emotePos.Y -= 32 + Sprite.SpriteHeight * 4;
                b.Draw(Game1.emoteSpriteSheet, emotePos,
                    new Rectangle(CurrentEmoteIndex * 16 % Game1.emoteSpriteSheet.Width,
                        CurrentEmoteIndex * 16 / Game1.emoteSpriteSheet.Width * 16, 16, 16),
                    Color.White, 0f, Vector2.Zero, 4f, SpriteEffects.None, layerDepth + 0.0001f);
            }
        }
    }
}
