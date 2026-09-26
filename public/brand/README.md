# Brand photography

Drop the storefront hero image here as one of:

    intro.jpg   intro.jpeg   intro.png   intro.webp

`components/BrandStory.tsx` looks for these on every request and uses the first one it
finds at `/brand/<file>`. Until a photo exists the page renders an empty image frame
instead of a stock placeholder — the layout is already sized for a real shoot.

Shoot notes: daylight, plain wall, the garment on a hanger or a person, front and back.
Aim for at least 1600px on the long edge; the container crops to a 4:5 portrait.
