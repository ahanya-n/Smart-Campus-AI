import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Stores the JWT access token.
abstract class TokenStorage {
  Future<String?> readToken();
  Future<void> saveToken(String token);
  Future<void> clearToken();
}

/// Keeps the token in the platform's secure storage
/// (Android Keystore-backed encryption on Android).
class SecureTokenStorage implements TokenStorage {
  SecureTokenStorage([FlutterSecureStorage? storage])
      : _storage = storage ?? const FlutterSecureStorage();

  static const _tokenKey = 'access_token';

  final FlutterSecureStorage _storage;

  @override
  Future<String?> readToken() => _storage.read(key: _tokenKey);

  @override
  Future<void> saveToken(String token) =>
      _storage.write(key: _tokenKey, value: token);

  @override
  Future<void> clearToken() => _storage.delete(key: _tokenKey);
}
