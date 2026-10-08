CREATE TABLE `relay_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`room` text NOT NULL,
	`request_id` text NOT NULL,
	`packet` text NOT NULL,
	FOREIGN KEY (`room`) REFERENCES `relay_rooms`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_events_request_id_unique` ON `relay_events` (`request_id`);--> statement-breakpoint
CREATE INDEX `events_room_id` ON `relay_events` (`room`,`id`);--> statement-breakpoint
CREATE TABLE `relay_rooms` (
	`code` text PRIMARY KEY NOT NULL,
	`host_hash` text NOT NULL,
	`phone_hash` text,
	`client_id` text,
	`host_seen` integer NOT NULL,
	`phone_seen` integer DEFAULT 0 NOT NULL,
	`expires` integer NOT NULL,
	`packet` text,
	`packet_at` integer DEFAULT 0 NOT NULL
);
