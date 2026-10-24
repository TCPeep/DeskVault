# Storage

Scan any folders or drives to find what's taking space, what you haven't opened in years and what you have more than one copy of. Then clean up safely.

![Storage page with duplicates](../images/storage-duplicates-dark.png)

## What it does

- **Scan** picks up every file under the folders you pick (default: your user folder).
- Reports totals by **age**: last opened < 6 months, 6-12 months, 1-2 years, 2-3 years, 3+ years.
- Finds **duplicates**: files with the same size and SHA-256. Grouped so you can keep one and recycle the extras.
- Flags **old `node_modules`**: rebuildable, often enormous, usually safe to delete.
- Shows the current **Recycle Bin** size with an **Empty** button.

## Age "basis"

By default, "age" means **last opened** (NTFS atime). Windows PCs record this on NTFS drives. Switch to **last changed** (mtime) if you prefer, from the Storage page's gear icon.

Backing a file up never bumps its atime: DeskVault puts it back after copying, so a weekly backup doesn't make everything look recently used.

## Safe clean-up

- **Delete** sends files to the **Recycle Bin**. The space comes back when you empty it.
- **Move to another drive** copies, verifies, then removes the original, keeping the layout under `<drive>\Vault Archive\`. If the destination has free space problems or the verify fails, nothing is removed.

> [!WARNING]
> Deleting a file that another program is actively using (an open video, a running database) can misbehave. Close the program first if you're not sure.

## Add to DeskVault

If a scan surfaces a folder you'd forgotten about and want to keep track of, select it and click **Add to Vault** &mdash; it joins your library like any other item.
