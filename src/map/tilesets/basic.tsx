import { Text } from "ink";
import type { ReactElement } from "react";
import tinycolor from "tinycolor2";

export type Tile = {
	description: string;
	passable: boolean;
	render: () => ReactElement;
};

export type TileSet = Record<string, Tile>;

export const blankTile: Tile & { symbol: string } = {
	symbol: "_",
	description: "nothing",
	passable: true,
	render: () => <Text> </Text>,
};

export const basicTileset: TileSet = {
	_: blankTile,
	g: {
		description: "grass",
		passable: true,
		render: () => <Text color={"greenBright"}>░</Text>,
	},
	G: {
		description: "tall grass",
		passable: true,
		render: () => <Text color={"green"}>▒</Text>,
	},
	w: {
		description: "shallow water",
		passable: true,
		render: () => (
			<Text bold color={"blue"} backgroundColor={"green"}>
				~
			</Text>
		),
	},
	d: {
		description: "deep water",
		passable: false,
		render: () => (
			<Text backgroundColor={"blue"} color={"blueBright"}>
				~
			</Text>
		),
	},
	p: {
		description: "cobblestone path",
		passable: true,
		render: () => <Text backgroundColor={"grey"}>░</Text>,
	},
	W: {
		description: "stone wall",
		passable: false,
		render: () => <Text color={"grey"}>▒</Text>,
	},
	B: {
		description: "bush",
		passable: false,
		render: () => <Text color={"green"}>▓</Text>,
	},
	T: {
		description: "tree",
		passable: false,
		render: () => (
			<Text bold color={tinycolor("green").darken(14).toHexString()}>
				█
			</Text>
		),
	},
	F: {
		description: "fence",
		passable: false,
		render: () => <Text color={"yellow"}>╋</Text>,
	},
	f: {
		description: "flowers",
		passable: true,
		render: () => (
			<Text bold color={"yellow"}>
				⚘
			</Text>
		),
	},
};

// aaa
// a♣︎a
