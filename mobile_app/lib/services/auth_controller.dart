import 'package:flutter/foundation.dart';

import '../models/app_user.dart';
import 'api_service.dart';
import 'token_storage.dart';

enum AuthStatus { unknown, authenticated, unauthenticated }

/// Holds the signed-in state and the current user.
class AuthController extends ChangeNotifier {
  AuthController({required this._api, required TokenStorage tokenStorage})
      : _storage = tokenStorage;

  final ApiService _api;
  final TokenStorage _storage;

  AuthStatus _status = AuthStatus.unknown;
  AppUser? _user;

  AuthStatus get status => _status;
  AppUser? get user => _user;

  /// Called on app start. Signs the user back in if a stored token is still
  /// valid. Throws [ApiException] on network errors so the splash screen can
  /// offer a retry instead of discarding a token that may still be good.
  Future<void> restoreSession() async {
    String? token;
    try {
      token = await _storage.readToken();
    } catch (_) {
      // Unreadable secure storage (e.g. after a backup restore): start fresh.
      await _safeClear();
    }

    if (token == null || token.isEmpty) {
      _setSignedOut();
      return;
    }

    try {
      _user = await _api.getCurrentUser();
      _status = AuthStatus.authenticated;
      notifyListeners();
    } on ApiException catch (e) {
      if (e.isUnauthorized) {
        await logout();
        return;
      }
      rethrow;
    }
  }

  Future<void> login({required String email, required String password}) async {
    final token = await _api.login(email: email, password: password);
    await _storage.saveToken(token);

    try {
      _user = await _api.getCurrentUser();
    } catch (_) {
      await _safeClear();
      rethrow;
    }

    _status = AuthStatus.authenticated;
    notifyListeners();
  }

  /// Reloads the user from GET /me. Signs out if the token is no longer valid.
  Future<void> refreshUser() async {
    try {
      _user = await _api.getCurrentUser();
      notifyListeners();
    } on ApiException catch (e) {
      if (e.isUnauthorized) await logout();
      rethrow;
    }
  }

  Future<void> linkStudentRecord({
    required String studentId,
    required String linkCode,
  }) async {
    _user = await _api.linkMyStudent(
      studentId: studentId,
      linkCode: linkCode,
    );
    notifyListeners();
  }

  Future<void> logout() async {
    await _safeClear();
    _setSignedOut();
  }

  void _setSignedOut() {
    _user = null;
    _status = AuthStatus.unauthenticated;
    notifyListeners();
  }

  Future<void> _safeClear() async {
    try {
      await _storage.clearToken();
    } catch (_) {
      // Nothing more we can do; the in-memory session is cleared regardless.
    }
  }
}
