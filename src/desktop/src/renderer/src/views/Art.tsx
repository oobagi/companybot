/**
 * The picture beside the landing and sign-in forms, drawn here instead of shipped as an image:
 * a few flat shapes on cream, with a touch of grain so it doesn't look like clip art.
 * Portrait composition that crops from the middle, so it fills any panel without stretching.
 */
export function Art({ className = "" }: { className?: string }) {
	return (
		<svg viewBox="0 0 1024 1536" preserveAspectRatio="xMidYMid slice" className={className} aria-hidden="true">
			<defs>
				<filter id="art-grain" x="0" y="0" width="100%" height="100%">
					<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
					<feColorMatrix type="saturate" values="0" />
				</filter>
			</defs>
			<rect width="1024" height="1536" fill="#f6f4ef" />
			<circle cx="310" cy="370" r="245" fill="#2f6bea" />
			<rect x="35" y="670" width="475" height="560" rx="80" fill="#f9c64e" />
			<path d="M575 565a230 230 0 0 1 460 0v700H575z" fill="#f27a62" />
			<circle cx="935" cy="1120" r="290" fill="#c9b1f5" />
			<path d="M0 1010C150 965 270 985 400 1080s170 180 300 190 220 20 324 50v216H0z" fill="#7fd3b0" />
			<rect width="1024" height="1536" filter="url(#art-grain)" opacity="0.14" style={{ mixBlendMode: "multiply" }} />
		</svg>
	);
}
