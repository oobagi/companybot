import type { MenuAction } from '@expo/ui/community/menu';
import Info from '@expo/material-symbols/info.xml';
import Edit from '@expo/material-symbols/edit_square.xml';
import Chats from '@expo/material-symbols/forum.xml';
import Pin from '@expo/material-symbols/keep.xml';
import Reply from '@expo/material-symbols/chat_bubble.xml';
import Copy from '@expo/material-symbols/content_copy.xml';
import React from '@expo/material-symbols/mood.xml';
import Delete from '@expo/material-symbols/delete.xml';
import Reorder from '@expo/material-symbols/swap_vert.xml';
import History from '@expo/material-symbols/history.xml';
import Lock from '@expo/material-symbols/lock.xml';
import Folder from '@expo/material-symbols/folder.xml';
import Add from '@expo/material-symbols/add.xml';
import Archive from '@expo/material-symbols/archive.xml';
import Undo from '@expo/material-symbols/undo.xml';
import Tag from '@expo/material-symbols/tag.xml';
import Widgets from '@expo/material-symbols/widgets.xml';
import People from '@expo/material-symbols/group.xml';
import Photo from '@expo/material-symbols/photo.xml';
import Pause from '@expo/material-symbols/pause.xml';
import Play from '@expo/material-symbols/play_arrow.xml';

const androidIcons = {
  'info.circle': Info,
  'square.and.pencil': Edit,
  pencil: Edit,
  'bubble.left.and.bubble.right': Chats,
  pin: Pin,
  'bubble.left': Reply,
  'doc.on.doc': Copy,
  'face.smiling': React,
  trash: Delete,
  'arrow.up.arrow.down': Reorder,
  'clock.arrow.circlepath': History,
  lock: Lock,
  folder: Folder,
  plus: Add,
  archivebox: Archive,
  'arrow.uturn.backward': Undo,
  number: Tag,
  'square.grid.2x2': Widgets,
  'person.2': People,
  photo: Photo,
  pause: Pause,
  play: Play,
};

/** Expo menus accept SF names on iOS and image assets on Android. */
export function menuIcon(icon: MenuAction['image']): MenuAction['image'] {
  if (process.env.EXPO_OS !== 'android' || typeof icon !== 'string') return icon;
  return androidIcons[icon as keyof typeof androidIcons];
}
