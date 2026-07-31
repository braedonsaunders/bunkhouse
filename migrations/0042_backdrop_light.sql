-- A backdrop for each theme.
--
-- One drawing cannot serve both. The palette is baked into the shapes — a room
-- drawn in near-black slate is unreadable on a light canvas and vice versa —
-- so asking somebody to pick "Dim" or "Bright" at draw time only ever produced
-- a backdrop that was wrong for half the people looking at it, and wrong for
-- everybody the moment they switched theme.
--
-- Both are drawn now, automatically, and the floor picks whichever matches. The
-- existing column keeps its meaning as the dark one, because that is what every
-- backdrop drawn so far actually is.

ALTER TABLE "departments" ADD COLUMN IF NOT EXISTS "backdrop_svg_light" text;
