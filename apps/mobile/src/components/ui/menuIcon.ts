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
};

/** Expo menus accept SF names on iOS and image assets on Android. */
export function menuIcon(icon: MenuAction['image']): MenuAction['image'] {
  if (process.env.EXPO_OS !== 'android' || typeof icon !== 'string') return icon;
  return androidIcons[icon as keyof typeof androidIcons];
}
