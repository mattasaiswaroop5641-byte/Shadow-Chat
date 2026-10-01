from app.core.database import mongo_tls_enabled


def test_atlas_srv_connections_use_tls() -> None:
    assert mongo_tls_enabled(
        "mongodb+srv://user:password@example.mongodb.net/shadowchat",
        "development",
    )
    assert not mongo_tls_enabled("mongodb://localhost:27017", "development")
    assert mongo_tls_enabled("mongodb://localhost:27017", "production")
